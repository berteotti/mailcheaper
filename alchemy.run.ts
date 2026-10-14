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

		// Everything both Workers read from process.env (lib/config.js and the provider modules). Optional values
		// default to empty, which turns their feature off; see .env.example for each one.
		const shared = {
			DB: db,
			JOBS_QUEUE: jobsQueue,
			// Exactly "true" on MailCheap Cloud: billing, plan limits, open sign-up.
			MAILCHEAP_CLOUD: optional("MAILCHEAP_CLOUD"),
			BETTER_AUTH_SECRET: Config.Redacted("BETTER_AUTH_SECRET"),
			ADMIN_EMAILS: Config.String("ADMIN_EMAILS"),
			ALLOWED_EMAILS: optional("ALLOWED_EMAILS"),
			RESEND_API_KEY: optionalSecret("RESEND_API_KEY"),
			EMAIL_FROM: optional("EMAIL_FROM"),
			STRIPE_SECRET_KEY: optionalSecret("STRIPE_SECRET_KEY"),
			STRIPE_WEBHOOK_SECRET: optionalSecret("STRIPE_WEBHOOK_SECRET"),
			// The kill switch: both Workers read it, so a deploy with anything but "true" stops every send.
			SENDING_ENABLED: Config.String("SENDING_ENABLED").pipe(Config.withDefault("false")),
			EMAIL_PROVIDER: optional("EMAIL_PROVIDER"),
			SEND_RATE_PER_SECOND: optional("SEND_RATE_PER_SECOND"),
			POSTSHIBA_API_KEY: optionalSecret("POSTSHIBA_API_KEY"),
			POSTSHIBA_TEAM_ID: optional("POSTSHIBA_TEAM_ID"),
			POSTSHIBA_BULK_CLUSTER_ID: optional("POSTSHIBA_BULK_CLUSTER_ID"),
			POSTSHIBA_TRANSACTIONAL_CLUSTER_ID: optional("POSTSHIBA_TRANSACTIONAL_CLUSTER_ID"),
			POSTSHIBA_WEBHOOK_SECRET: optionalSecret("POSTSHIBA_WEBHOOK_SECRET"),
			POSTSHIBA_API_URL: optional("POSTSHIBA_API_URL"),
			POSTSHIBA_INJECT_URL: optional("POSTSHIBA_INJECT_URL"),
			CREDENTIALS_ENCRYPTION_KEY: optionalSecret("CREDENTIALS_ENCRYPTION_KEY"),
			SES_REGION: Config.String("SES_REGION").pipe(Config.withDefault("us-east-1")),
			SES_ACCESS_KEY_ID: optionalSecret("SES_ACCESS_KEY_ID"),
			SES_SECRET_ACCESS_KEY: optionalSecret("SES_SECRET_ACCESS_KEY"),
			SES_AWS_ACCOUNT_ID: optional("SES_AWS_ACCOUNT_ID"),
			SES_SNS_TOPIC_ARN: optional("SES_SNS_TOPIC_ARN"),
			SES_TENANT_SNS_TOPIC_ARN: optional("SES_TENANT_SNS_TOPIC_ARN"),
			SHARED_DOMAIN: optional("SHARED_DOMAIN"),
			ARCHIVE_CNAME_TARGET: optional("ARCHIVE_CNAME_TARGET"),
			DNS_BROKER_URL: optional("DNS_BROKER_URL"),
			DNS_BROKER_SECRET: optionalSecret("DNS_BROKER_SECRET"),
			// Uploads: R2, public through ASSET_DOMAIN or the app's /media. Account purges run in the jobs Worker.
			ASSETS_BUCKET: assets,
			ASSET_URL: assetDomain ? `https://${assetDomain}` : "",
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
				GOOGLE_CLIENT_ID: optional("GOOGLE_CLIENT_ID"),
				GOOGLE_CLIENT_SECRET: optionalSecret("GOOGLE_CLIENT_SECRET"),
				APP_URL: appDomain ? `https://${appDomain}` : Cloudflare.Worker.URL,
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
						// Shared modules import Next.js APIs that only the app Worker (vinext) provides; the jobs Worker
						// gets small stand-ins, never Next.js itself (its bundled code expects Node).
						alias: {
							"@": resolve("."),
							"server-only": resolve("worker/empty.js"),
							"next/headers": resolve("worker/next/headers.js"),
							"next/navigation": resolve("worker/next/navigation.js"),
							"next/server": resolve("worker/next/server.js"),
							"next/cache": resolve("worker/next/cache.js"),
						},
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

		return {
			url: appUrl,
			sesWebhookUrl: Output.interpolate`${appUrl}/api/webhooks/ses`,
			sesTenantWebhookUrl: Output.interpolate`${appUrl}/api/webhooks/ses-tenants`,
			postshibaWebhookUrl: Output.interpolate`${appUrl}/api/webhooks/postshiba`,
			stripeWebhookUrl: Output.interpolate`${appUrl}/api/webhooks/stripe`,
			assetUrl: assetDomain || "(served by the app at /media)",
		};
	}),
);
