import crypto from "node:crypto";
import { findDnsRecord } from "../stubs/dns-broker.mjs";

// An in-memory PostShiba behind a mocked fetch: tenants, SMTP credentials, sending domains, POST /sends with
// Idempotency-Key, HTTP inject and clusters, as its API reference describes them. Nothing reaches the network.
export const POSTSHIBA = {
	apiUrl: "https://app.postshiba.test",
	injectUrl: "https://inject.postshiba.test/api/inject/v1",
	apiKey: "ps_test_key",
	teamId: "TeAm01",
	bulkClusterId: "BuLk01",
	transactionalClusterId: "TrAn01",
	webhookSecret: "ps-webhook-secret-for-tests",
};

export const POSTSHIBA_ENV = {
	EMAIL_PROVIDER: "postshiba",
	POSTSHIBA_API_KEY: POSTSHIBA.apiKey,
	POSTSHIBA_TEAM_ID: POSTSHIBA.teamId,
	POSTSHIBA_BULK_CLUSTER_ID: POSTSHIBA.bulkClusterId,
	POSTSHIBA_TRANSACTIONAL_CLUSTER_ID: POSTSHIBA.transactionalClusterId,
	POSTSHIBA_WEBHOOK_SECRET: POSTSHIBA.webhookSecret,
	POSTSHIBA_API_URL: POSTSHIBA.apiUrl,
	POSTSHIBA_INJECT_URL: POSTSHIBA.injectUrl,
	CREDENTIALS_ENCRYPTION_KEY: crypto.randomBytes(32).toString("base64"),
};

function reply(status, body) {
	return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function header(headers, name) {
	if (!headers) return undefined;
	if (headers instanceof Headers) return headers.get(name) ?? undefined;
	const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
	return key ? headers[key] : undefined;
}

function domainOf(address) {
	return (/<([^<>]+)>\s*$/.exec(address)?.[1] ?? address).split("@")[1]?.toLowerCase();
}

export function createFakePostshiba() {
	const state = {
		tenants: new Map(),
		credentials: new Map(),
		domains: new Map(),
		sends: [],
		injects: [],
		calls: [],
		idempotency: new Map(),
		failures: [],
		// tenantId:email pairs on a tenant's suppression list.
		suppressed: new Set(),
		isDnsVisible: true,
		clusters: new Map([
			[POSTSHIBA.bulkClusterId, { id: POSTSHIBA.bulkClusterId, name: "bulk", plan: "small", classification: "bulk", emails_per_hour: 40_000, emails_per_day: 240_000, status: "active", sending_ready: true }],
			[POSTSHIBA.transactionalClusterId, { id: POSTSHIBA.transactionalClusterId, name: "transactional", plan: "micro", classification: "transactional", emails_per_hour: 4000, emails_per_day: 24_000, status: "active", sending_ready: true }],
		]),
	};
	let sequence = 0;
	const newId = (prefix) => `${prefix}${(++sequence).toString(36).padStart(4, "0")}`;

	// The next matching call answers this instead: { method, path (RegExp), status, body, times }.
	function fail(rule) {
		state.failures.push({ times: 1, ...rule });
	}

	function findFailure(method, path) {
		const index = state.failures.findIndex((rule) => (!rule.method || rule.method === method) && rule.path.test(path));
		if (index === -1) return null;
		const rule = state.failures[index];
		if (--rule.times <= 0) state.failures.splice(index, 1);
		return rule;
	}

	function isDomainReady(name, tenantId) {
		const domain = [...state.domains.values()].find((item) => item.name === name);
		return Boolean(domain && domain.tenant_id === tenantId && domain.sending_allowed && !domain.suspended);
	}

	// Its two CNAMEs published by MailCheap on a Vercel-hosted zone, as PostShiba would find them in DNS once
	// they've propagated (state.isDnsVisible).
	function isPublished(domain) {
		return (
			state.isDnsVisible &&
			findDnsRecord(domain.dkim_cname_host, "CNAME")?.value === domain.dkim_cname_target &&
			findDnsRecord(domain.return_path_host, "CNAME")?.value === domain.return_path_target
		);
	}

	// Marks a domain as PostShiba would once its two CNAMEs are in.
	function verifyDomain(name) {
		const domain = [...state.domains.values()].find((item) => item.name === name);
		Object.assign(domain, { dkim_status: "verified", return_path_status: "verified", sending_allowed: true });
	}

	function handleInject(init) {
		const authorization = header(init.headers, "authorization") ?? "";
		const [username, password] = Buffer.from(authorization.replace(/^Basic /, ""), "base64").toString().split(":");
		const credential = [...state.credentials.values()].find((item) => item.username === username && item.cluster_id === POSTSHIBA.bulkClusterId);
		if (!credential || credential.password !== password) return reply(401, { error: "authentication failed" });
		const body = JSON.parse(init.body);
		const tenant = state.tenants.get(credential.tenant_id);
		if (tenant.held) return reply(200, { success_count: 0, fail_count: 1, failed_recipients: [body.recipients[0].email], errors: ["550 operator_hold"] });
		if (tenant.suspended) return reply(200, { success_count: 0, fail_count: 1, failed_recipients: [body.recipients[0].email], errors: ["550 sending disabled"] });
		if (!isDomainReady(domainOf(body.envelope_sender), credential.tenant_id)) {
			return reply(200, { success_count: 0, fail_count: 1, failed_recipients: [body.recipients[0].email], errors: ["550 unverified domain"] });
		}
		if (state.suppressed.has(`${credential.tenant_id}:${body.recipients[0].email}`)) {
			return reply(200, { success_count: 0, fail_count: 1, failed_recipients: [body.recipients[0].email], errors: ["550 suppressed"] });
		}
		state.injects.push({ username, tenantId: credential.tenant_id, body });
		return reply(200, { success_count: 1, fail_count: 0, failed_recipients: [], errors: [] });
	}

	function handleSend({ clusterId, body, init }) {
		const key = header(init.headers, "idempotency-key");
		const fingerprint = JSON.stringify(body);
		if (key && state.idempotency.has(key)) {
			const first = state.idempotency.get(key);
			return first.fingerprint === fingerprint ? reply(201, first.response) : reply(409, { error: "idempotency_conflict", field: "Idempotency-Key", message: "reused with a different body" });
		}
		const tenant = [...state.tenants.values()].find((item) => item.id === body.tenant || item.slug === body.tenant);
		if (!tenant) return reply(422, { error: "invalid", field: "tenant", message: "is unknown" });
		if (tenant.held) return reply(403, { error: "operator_hold", field: "tenant", message: "paused by PostShiba" });
		if (tenant.suspended) return reply(403, { error: "tenant_suspended", field: "tenant", message: "is suspended" });
		const hasCredential = [...state.credentials.values()].some((item) => item.tenant_id === tenant.id && item.cluster_id === clusterId);
		if (!hasCredential) return reply(403, { error: "credential_missing", field: "cluster", message: "no live credential for the tenant" });
		if (!isDomainReady(domainOf(body.from), tenant.id)) return reply(403, { error: "domain_unverified", field: "from", message: "must be a verified sending domain" });
		const response = { queued: true, message_id: `${newId("m")}@postshiba.test`, from: body.from, to: body.to, suppressed: [], subject: body.subject, unique_args: body.unique_args };
		state.sends.push({ clusterId, key, body, response });
		if (key) state.idempotency.set(key, { fingerprint, response });
		return reply(201, response);
	}

	function route({ method, path, body, init }) {
		const team = `/api/v1/teams/${POSTSHIBA.teamId}`;
		let match;
		if (path.startsWith("/api/v1/teams/") && !path.startsWith(`${team}/`)) return reply(404, { error: "team_mismatch" });

		if (method === "POST" && path === `${team}/tenants`) {
			const { name, slug } = body.tenant;
			if ([...state.tenants.values()].some((item) => item.slug === slug)) return reply(422, { errors: ["Slug has already been taken"] });
			const tenant = { id: newId("Tn"), name, slug, suspended: false };
			state.tenants.set(tenant.id, tenant);
			return reply(201, tenant);
		}
		if (method === "GET" && path === `${team}/tenants`) return reply(200, [...state.tenants.values()].map(({ held, ...tenant }) => tenant));
		// Like PostShiba: the tenant's SMTP credentials go with it, its sending domains move to the team's default tenant.
		if ((match = /^\/api\/v1\/tenants\/([^/]+)$/.exec(path)) && method === "DELETE") {
			if (!state.tenants.delete(match[1])) return reply(404, { error: "Not found" });
			for (const [id, credential] of state.credentials) if (credential.tenant_id === match[1]) state.credentials.delete(id);
			for (const domain of state.domains.values()) if (domain.tenant_id === match[1]) domain.tenant_id = "default";
			return reply(204);
		}
		if ((match = /^\/api\/v1\/tenants\/([^/]+)\/(suspend|resume)$/.exec(path)) && method === "POST") {
			const tenant = state.tenants.get(match[1]);
			if (!tenant) return reply(404, { error: "Not found" });
			if (match[2] === "resume" && tenant.held) return reply(403, { error: "operator_hold" });
			tenant.suspended = match[2] === "suspend";
			return reply(200, { id: tenant.id, name: tenant.name, slug: tenant.slug, suspended: tenant.suspended });
		}
		if ((match = /^\/api\/v1\/teams\/[^/]+\/clusters\/([^/]+)\/smtp_credentials$/.exec(path)) && method === "POST") {
			const tenantId = body.smtp_credential.tenant_id;
			if (!state.tenants.has(tenantId)) return reply(422, { errors: ["Tenant must exist"] });
			const credential = { id: newId("Cr"), username: `smtp_${sequence}`, password: crypto.randomBytes(18).toString("base64url"), tenant_id: tenantId, cluster_id: match[1] };
			state.credentials.set(credential.id, credential);
			return reply(201, credential);
		}
		if (method === "POST" && path === `${team}/sending_domains`) {
			const { name, tenant_id: tenantId } = body.sending_domain;
			if ([...state.domains.values()].some((item) => item.name === name)) return reply(422, { errors: ["Name has already been taken"] });
			const id = newId("Dm");
			const domain = {
				id,
				name,
				tenant_id: tenantId,
				dkim_status: "pending",
				return_path_status: "pending",
				dmarc_status: "pending",
				sending_allowed: false,
				dkim_selector: "ps1",
				dkim_manual: false,
				dkim_cname_host: `ps1._domainkey.${name}`,
				dkim_cname_target: `${id}.customers.postshiba.test`,
				dmarc_host: `_dmarc.${name}`,
				dmarc_record: "v=DMARC1; p=none;",
				return_path_host: `rp.${name}`,
				return_path_target: "rp.postshiba.test",
				last_verification_error: null,
				suspended: false,
				operator_held: false,
			};
			state.domains.set(id, domain);
			return reply(201, domain);
		}
		if (method === "GET" && path === `${team}/sending_domains`) return reply(200, [...state.domains.values()]);
		if ((match = /^\/api\/v1\/sending_domains\/([^/]+)(\/verify)?$/.exec(path))) {
			const domain = state.domains.get(match[1]);
			if (!domain) return reply(404, { error: "Not found" });
			if (isPublished(domain)) verifyDomain(domain.name);
			if (method === "DELETE" && !match[2]) {
				state.domains.delete(match[1]);
				return reply(204);
			}
			if ((method === "GET" && !match[2]) || (method === "POST" && match[2])) return reply(200, domain);
		}
		if ((match = /^\/api\/v1\/teams\/[^/]+\/clusters\/([^/]+)\/sends$/.exec(path)) && method === "POST") return handleSend({ clusterId: match[1], body, init });
		if ((match = /^\/api\/v1\/clusters\/([^/]+)$/.exec(path)) && method === "GET") {
			const cluster = state.clusters.get(match[1]);
			return cluster ? reply(200, cluster) : reply(404, { error: "team_mismatch" });
		}
		return reply(404, { error: "Not found" });
	}

	async function handle(url, init = {}) {
		const method = init.method ?? "GET";
		const { pathname } = new URL(url);
		const path = url.startsWith(POSTSHIBA.injectUrl) ? "/inject" : pathname;
		const body = path !== "/inject" && typeof init.body === "string" ? JSON.parse(init.body) : null;
		state.calls.push({ method, path, body, headers: init.headers });
		const failure = findFailure(method, path);
		if (failure) {
			if (failure.throws) throw failure.throws;
			return reply(failure.status, failure.body);
		}
		if (path === "/inject") return handleInject(init);
		if (header(init.headers, "authorization") !== `Bearer ${POSTSHIBA.apiKey}`) return reply(401, { error: "Invalid token or no user signed in" });
		return route({ method, path, body, init });
	}

	function isPostshibaUrl(url) {
		return url.startsWith(POSTSHIBA.apiUrl) || url.startsWith(POSTSHIBA.injectUrl);
	}

	// Answers PostShiba's URLs and hands every other request to the fetch already installed.
	function install() {
		const previous = globalThis.fetch;
		globalThis.fetch = (input, init) => {
			const url = String(input?.url ?? input);
			return isPostshibaUrl(url) ? handle(url, init) : previous(input, init);
		};
		return () => {
			globalThis.fetch = previous;
		};
	}

	function callsTo(method, pattern) {
		return state.calls.filter((call) => call.method === method && pattern.test(call.path));
	}

	function hold(tenantId) {
		state.tenants.get(tenantId).held = true;
	}

	function suppress(tenantId, email) {
		state.suppressed.add(`${tenantId}:${email}`);
	}

	return { state, fail, verifyDomain, install, callsTo, hold, suppress, handle };
}
