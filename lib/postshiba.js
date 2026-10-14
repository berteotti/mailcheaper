import "server-only";

// Every call to PostShiba lives in this file, like lib/ses.js holds every AWS call. Tests answer them with a
// mocked fetch. Errors keep PostShiba's error string in providerCode (never in code, which the API answers with).
const API_URL = "https://app.postshiba.com";
const INJECT_URL = "https://inject.postshiba.com/api/inject/v1";
const TIMEOUT_MS = 10_000;
// A send waits for the cluster to accept the message.
const SEND_TIMEOUT_MS = 20_000;
const REQUIRED = ["POSTSHIBA_API_KEY", "POSTSHIBA_TEAM_ID", "POSTSHIBA_BULK_CLUSTER_ID"];

export function getPostshibaConfig(env = process.env) {
	const missing = REQUIRED.filter((name) => !String(env[name] ?? "").trim());
	if (missing.length > 0) throw new Error(`PostShiba is not configured (${missing.join(", ")})`);
	return {
		apiKey: env.POSTSHIBA_API_KEY.trim(),
		teamId: env.POSTSHIBA_TEAM_ID.trim(),
		bulkClusterId: env.POSTSHIBA_BULK_CLUSTER_ID.trim(),
		// One cluster sends everything until a second is set; then signup and test emails never wait behind a campaign.
		transactionalClusterId: (env.POSTSHIBA_TRANSACTIONAL_CLUSTER_ID || env.POSTSHIBA_BULK_CLUSTER_ID).trim(),
		apiUrl: (env.POSTSHIBA_API_URL || API_URL).trim().replace(/\/+$/, ""),
		injectUrl: (env.POSTSHIBA_INJECT_URL || INJECT_URL).trim(),
	};
}

function readRetryAfter(headers) {
	const seconds = Number.parseInt(headers?.get("retry-after") ?? "", 10);
	return Number.isInteger(seconds) && seconds > 0 ? seconds : null;
}

function describe(body) {
	if (typeof body === "string") return body.slice(0, 200);
	if (Array.isArray(body?.errors)) return body.errors.join("; ").slice(0, 200);
	return typeof body?.message === "string" ? body.message.slice(0, 200) : "";
}

function postshibaError({ label, status = null, body = null, headers, cause }) {
	const providerCode = typeof body?.error === "string" ? body.error : null;
	const detail = describe(body);
	const answer = status ? `${status}${providerCode ? ` ${providerCode}` : ""}` : cause?.name === "TimeoutError" ? "timed out" : "no answer";
	return Object.assign(new Error(`PostShiba ${label}: ${answer}${detail ? ` (${detail})` : ""}`), {
		name: "PostshibaError",
		status,
		providerCode,
		field: typeof body?.field === "string" ? body.field : null,
		retryable: typeof body?.retryable === "boolean" ? body.retryable : null,
		detail,
		retryAfter: readRetryAfter(headers),
		isTimeout: cause?.name === "TimeoutError",
		cause,
	});
}

async function readBody(response) {
	if (response.status === 204) return null;
	const text = await response.text().catch(() => "");
	try {
		return text ? JSON.parse(text) : null;
	} catch {
		return text;
	}
}

async function call(url, { label, method, headers, body, timeoutMs = TIMEOUT_MS }) {
	let response;
	try {
		response = await fetch(url, {
			method,
			headers: { Accept: "application/json", ...(body !== undefined && { "Content-Type": "application/json" }), ...headers },
			...(body !== undefined && { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (cause) {
		throw postshibaError({ label, cause });
	}
	const data = await readBody(response);
	if (!response.ok) throw postshibaError({ label, status: response.status, body: data, headers: response.headers });
	return data;
}

function request(path, { method = "GET", body, headers = {}, timeoutMs } = {}) {
	const { apiKey, apiUrl } = getPostshibaConfig();
	return call(`${apiUrl}${path}`, { label: `${method} ${path}`, method, body, timeoutMs, headers: { Authorization: `Bearer ${apiKey}`, ...headers } });
}

function teamPath(path) {
	return `/api/v1/teams/${encodeURIComponent(getPostshibaConfig().teamId)}${path}`;
}

const id = encodeURIComponent;

export function createTenant({ name, slug }) {
	return request(teamPath("/tenants"), { method: "POST", body: { tenant: { name, slug } } });
}

export function listTenants() {
	return request(teamPath("/tenants"));
}

export function suspendTenant(tenantId) {
	return request(`/api/v1/tenants/${id(tenantId)}/suspend`, { method: "POST" });
}

export function resumeTenant(tenantId) {
	return request(`/api/v1/tenants/${id(tenantId)}/resume`, { method: "POST" });
}

// Its SMTP credentials go with it; its sending domains move to the team's default tenant, so they go first.
export async function deleteTenant(tenantId) {
	try {
		await request(`/api/v1/tenants/${id(tenantId)}`, { method: "DELETE" });
	} catch (error) {
		if (error.status !== 404) throw error;
	}
}

// The password is in this answer only.
export function createSmtpCredential({ clusterId, tenantId }) {
	return request(teamPath(`/clusters/${id(clusterId)}/smtp_credentials`), { method: "POST", body: { smtp_credential: { tenant_id: tenantId } } });
}

export function createSendingDomain({ name, tenantId }) {
	return request(teamPath("/sending_domains"), { method: "POST", body: { sending_domain: { name, tenant_id: tenantId } } });
}

export function listSendingDomains() {
	return request(teamPath("/sending_domains"));
}

export function getSendingDomain(domainId) {
	return request(`/api/v1/sending_domains/${id(domainId)}`);
}

// Counts toward PostShiba's 60 an hour per key for domain checks, credentials and new domains.
export function verifySendingDomain(domainId) {
	return request(`/api/v1/sending_domains/${id(domainId)}/verify`, { method: "POST" });
}

export async function deleteSendingDomain(domainId) {
	try {
		await request(`/api/v1/sending_domains/${id(domainId)}`, { method: "DELETE" });
	} catch (error) {
		if (error.status !== 404) throw error;
	}
}

export function getCluster(clusterId) {
	return request(`/api/v1/clusters/${id(clusterId)}`);
}

// A retry with the same key and body answers what the first one did, for 24 hours, and never sends twice.
export function createSend({ clusterId, idempotencyKey, send }) {
	return request(teamPath(`/clusters/${id(clusterId)}/sends`), {
		method: "POST",
		body: send,
		headers: { "Idempotency-Key": idempotencyKey },
		timeoutMs: SEND_TIMEOUT_MS,
	});
}

// HTTP inject on the bulk cluster, with the tenant's SMTP login.
export function inject({ username, password, message }) {
	const { injectUrl } = getPostshibaConfig();
	return call(injectUrl, {
		label: "inject",
		method: "POST",
		body: message,
		timeoutMs: SEND_TIMEOUT_MS,
		headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` },
	});
}
