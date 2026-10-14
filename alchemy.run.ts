import { resolve } from "node:path";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

// Must match worker/jobs.js.
const MINUTE_CRON = "* * * * *";
const BACKUP_CRON = "17 3 * * *";
// nodejs_compat is on by default from 2026-08-04 (and Vinext adds it itself).
const COMPATIBILITY = { date: "2026-10-09", flags: [] };
const optional = (name: string) => Config.String(name).pipe(Config.withDefault(""));
// Without SES keys the SDK has no credentials in a Worker, so sends fail until they are set.
const optionalSecret = (name: string) => Config.Redacted(name).pipe(Config.withDefault(Redacted.make("")));

export default Alchemy.Stack(
	"mailcheap",
	{
		providers: Cloudflare.providers(),
		state: Layer.unwrap(Effect.map(Alchemy.Stage, (stage) => (stage === "local" ? Alchemy.localState() : Cloudflare.state()))),
	},
	Effect.gen(function* () {
		const stage = yield* Alchemy.Stage;
		const isProd = stage === "prod";
		// Owned domains, optional until a stage goes live. Their zones must already be on the Cloudflare account.
		const appDomain = yield* optional("APP_DOMAIN");
		const assetDomain = yield* optional("ASSET_DOMAIN");

		// Data outlives a removed stack in prod; logical IDs never change, so redeploys reuse these resources.
		const db = yield* Cloudflare.D1.Database("Database", { migrations: "./migrations" }).pipe(RemovalPolicy.retain(isProd));
		const assets = yield* Cloudflare.R2.Bucket("Assets", {
			domains: assetDomain ? [{ name: assetDomain }] : [],
		}).pipe(RemovalPolicy.retain(isProd));
		const backups = yield* Cloudflare.R2.Bucket("Backups").pipe(RemovalPolicy.retain(isProd));
		const jobsQueue = yield* Cloudflare.Queues.Queue("JobsQueue");
		const deadLetters = yield* Cloudflare.Queues.Queue("JobsDeadLetters");

		const shared = {
			DB: db,
			JOBS_QUEUE: jobsQueue,
			ADMIN_EMAIL: Config.String("ADMIN_EMAIL"),
			SESSION_SECRET: Config.Redacted("SESSION_SECRET"),
			SES_REGION: Config.String("SES_REGION").pipe(Config.withDefault("us-east-1")),
			SES_ACCESS_KEY_ID: optionalSecret("SES_ACCESS_KEY_ID"),
			SES_SECRET_ACCESS_KEY: optionalSecret("SES_SECRET_ACCESS_KEY"),
			SES_CONFIGURATION_SET: optional("SES_CONFIGURATION_SET"),
			SEND_RATE_PER_SECOND: optional("SEND_RATE_PER_SECOND"),
			ALERT_FROM: optional("ALERT_FROM"),
			ARCHIVE_HOSTS: optional("ARCHIVE_HOSTS"),
			// The kill switch: both Workers read it, so a deploy with anything but "true" stops every send.
			SENDING_ENABLED: Config.String("SENDING_ENABLED").pipe(Config.withDefault("false")),
			// Local only: send to a mock SES instead of AWS.
			...(stage === "local" ? { SES_ENDPOINT: optional("SES_ENDPOINT") } : {}),
		};

		const app = yield* Cloudflare.Website.Vinext("App", {
			// No `main`: Website.Vinext passes it alongside its own source provider, which the deploy rejects
			// ("source is mutually exclusive with main"). Its default entry, worker/index.ts, is ours.
			compatibility: COMPATIBILITY,
			domain: appDomain || undefined,
			observability: { enabled: true },
			env: {
				...shared,
				ADMIN_PASSWORD: Config.Redacted("ADMIN_PASSWORD"),
				SES_SNS_TOPIC_ARN: optional("SES_SNS_TOPIC_ARN"),
				APP_URL: appDomain ? `https://${appDomain}` : Cloudflare.Worker.URL,
				// Empty: uploads are served by the app itself at /media (lib/assets.js).
				ASSET_URL: assetDomain ? `https://${assetDomain}` : "",
				ASSETS_BUCKET: assets,
				RATE_LIMITER: Cloudflare.DurableObject("RateLimiter"),
				SES_PACER: Cloudflare.DurableObject("SesPacer"),
			},
		});

		const appUrl = appDomain ? `https://${appDomain}` : Output.interpolate`${app.url}`;
		const jobs = yield* Cloudflare.Worker("Jobs", {
			main: "worker/jobs.js",
			compatibility: COMPATIBILITY,
			crons: [MINUTE_CRON, BACKUP_CRON],
			workersDev: false,
			observability: { enabled: true },
			build: {
				input: {
					resolve: {
						alias: { "@": resolve("."), "server-only": resolve("worker/empty.js") },
						// Like the app's Vite build: packages' Worker/browser builds (the AWS SDK's fetch-based
						// runtime config), not their Node builds.
						conditionNames: ["workerd", "worker", "browser", "import", "module", "default"],
						mainFields: ["browser", "module", "main"],
						aliasFields: [["browser"]],
					},
				},
			},
			env: {
				...shared,
				APP_URL: appUrl,
				APP: app,
				BACKUPS_BUCKET: backups,
				SES_PACER: Cloudflare.DurableObject("SesPacer", { scriptName: app.workerName }),
			},
		});

		// Small batches: each message is a batch of up to 50 sends paced at SEND_RATE_PER_SECOND.
		yield* Cloudflare.Queues.Consumer("JobsConsumer", {
			queueId: jobsQueue.queueId,
			scriptName: jobs.workerName,
			deadLetterQueue: deadLetters.queueName,
			settings: { batchSize: 5, maxConcurrency: 4, maxRetries: 8, maxWaitTimeMs: 2000 },
		});

		return { url: appUrl, sesWebhookUrl: Output.interpolate`${appUrl}/api/webhooks/ses`, assetUrl: assetDomain || "(served by the app at /media)" };
	}),
);
