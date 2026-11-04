import "server-only";
import { findOwners } from "@/lib/accounts";
import { revalidateArchive } from "@/lib/archive-data";
import { isAdmin } from "@/lib/auth";
import { getArchiveCnameTarget } from "@/lib/config";
import { execute, getAll, getOne, getValue, isUniqueConstraint } from "@/lib/db";
import { getDmarcHosts, getDmarcStatus } from "@/lib/dmarc-rules";
import { readTxt } from "@/lib/dns-check";
import { getEmailProvider, getProvider } from "@/lib/email-provider";
import { isServedHere } from "@/lib/host-check";
import { insertRow, updateOne, updateRows } from "@/lib/records";
import { getArchiveHostProblem, getDomainProblem, getEmailDomain, normalizeDomainInput, normalizeHostInput } from "@/lib/sender-rules";
import { isObjectIdString } from "@/lib/validation";

// Campaigns that would break halfway if their from domain went away.
const ACTIVE_CAMPAIGN_STATUSES = ["sending", "scheduled", "paused"];
const READ_EVERY_MS = 60_000;

// The code is one of lib/actions/errors.js, for the API and MCP.
function domainError(message, code = "validation_failed") {
	return Object.assign(new Error(message), { isUserError: true, code });
}

function byId(account, id) {
	return { where: "accountId = ? AND _id = ?", params: [account._id, String(id)] };
}

async function findDomain(account, domainId) {
	const domain = isObjectIdString(String(domainId))
		? await getOne("SELECT * FROM domains WHERE accountId = ? AND _id = ?", [account._id, String(domainId).toLowerCase()])
		: null;
	if (!domain) throw domainError("Domain not found", "not_found");
	return domain;
}

// A newsletter uses its from domain's archive subdomain once that subdomain reaches MailCheap.
export async function syncArchiveHosts(accountId) {
	const [domains, newsletters] = await Promise.all([
		getAll("SELECT domain, archiveHost FROM domains WHERE accountId = ? AND archiveHostVerified = 1", [String(accountId)]),
		getAll("SELECT _id, fromEmail, archiveHost FROM newsletters WHERE accountId = ? ORDER BY createdAt, _id", [String(accountId)]),
	]);
	const taken = new Set();
	let isChanged = false;
	for (const newsletter of newsletters) {
		const host = domains.find(({ domain }) => domain === getEmailDomain(newsletter.fromEmail))?.archiveHost;
		const next = host && !taken.has(host) ? host : undefined;
		if (next) taken.add(next);
		if (next === (newsletter.archiveHost ?? undefined)) continue;
		isChanged = true;
		await updateRows("newsletters", { where: "accountId = ? AND _id = ?", params: [String(accountId), newsletter._id] }, next ? { set: { archiveHost: next } } : { unset: ["archiveHost"] });
	}
	if (isChanged) revalidateArchive();
}

// A domain added at another provider, before EMAIL_PROVIDER changed, is added again at this one: it gets new
// DNS records, and sends once they're in.
async function moveToProvider({ account, domain, provider }) {
	if ((domain.provider ?? "ses") === provider.id) return domain;
	const { providerDomainId } = await provider.addDomain({ account, domain: domain.domain });
	const set = {
		provider: provider.id,
		mailFromDomain: provider.getMailFromDomain(domain.domain),
		verified: false,
		dkimStatus: "PENDING",
		mailFromStatus: "PENDING",
		records: [],
		...(providerDomainId && { providerDomainId }),
	};
	return updateOne("domains", byId(account, domain._id), { set, unset: providerDomainId ? [] : ["providerDomainId"] });
}

function toProviderFields(status) {
	if (status.missing) return { verified: false, dkimStatus: "NOT_STARTED", mailFromStatus: "NOT_STARTED" };
	return {
		verified: status.verified,
		dkimStatus: status.dkimStatus,
		mailFromStatus: status.mailFromStatus ?? "PENDING",
		records: status.records,
	};
}

// A failed lookup says nothing, so the last answer stays (null).
async function findDmarc(domain) {
	for (const host of getDmarcHosts(domain)) {
		const records = await readTxt(`_dmarc.${host}`);
		if (!records) return null;
		const status = getDmarcStatus(records);
		if (status) return { status, host };
	}
	return { status: "missing" };
}

// The domain at the email provider and its DMARC record, as the fields to save. verify asks the provider to look at
// DNS now; a provider with a verification budget may answer with what it found a moment ago (unchanged).
async function readStatus({ account, domain, provider, verify }) {
	const [status, dmarc] = await Promise.all([provider.readDomain({ account, domain, verify }), findDmarc(domain.domain)]);
	if (status.error) throw Object.assign(new Error(`${provider.name} didn't answer: ${status.error}`), { code: "unavailable" });
	return { isUnchanged: Boolean(status.unchanged), set: { ...(dmarc && { dmarc }), ...(!status.unchanged && toProviderFields(status)) } };
}

function saveStatus({ account, domain, set }) {
	if (set.verified && !domain.verifiedAt) set.verifiedAt = new Date();
	return updateOne("domains", byId(account, domain._id), { set });
}

// Also whether its archive subdomain reaches this server: its links move there only once it does.
export async function checkDomain({ account, domainId, verify = true }) {
	const provider = getEmailProvider();
	const domain = await moveToProvider({ account, domain: await findDomain(account, domainId), provider });
	const [{ isUnchanged, set }, isArchiveLive] = await Promise.all([
		readStatus({ account, domain, provider, verify }),
		Boolean(getArchiveCnameTarget()) && isServedHere(domain.archiveHost),
	]);
	const checked = await saveStatus({ account, domain, set: { ...set, archiveHostVerified: isArchiveLive, ...(!isUnchanged && { checkedAt: new Date() }) } });
	if (isArchiveLive !== domain.archiveHostVerified) await syncArchiveHosts(account._id);
	return checked;
}

const isRecent = (date) => Boolean(date) && Date.now() - new Date(date).getTime() < READ_EVERY_MS;

// The archive subdomain waits for Check now: a newsletter moving its archive there refreshes the archive's cached
// pages, which can't happen while a page renders.
function isWaiting(domain, provider) {
	const isSetUp = domain.verified && domain.dkimStatus === "SUCCESS" && domain.mailFromStatus === "SUCCESS" && domain.dmarc?.status === "found";
	return (domain.provider ?? "ses") === provider.id && !isSetUp && !isRecent(domain.checkedAt) && !isRecent(domain.readAt);
}

// For the Domains page: a domain still being set up, its DMARC record included, is read again, at most once a minute
// and without the provider's verification budget, as PostShiba keeps checking DNS on its own. One from another
// provider waits for Check now, which adds it at this one.
export async function refreshDomains(account, domains) {
	const provider = getEmailProvider();
	if (!provider.isConfigured()) return domains;
	return Promise.all(
		domains.map(async (domain) => {
			if (!isWaiting(domain, provider)) return domain;
			try {
				const { set } = await readStatus({ account, domain, provider, verify: false });
				return await saveStatus({ account, domain, set: { ...set, readAt: new Date() } });
			} catch (error) {
				console.warn(`[domains] ${domain.domain} not read again: ${error.message}`);
				return domain;
			}
		})
	);
}

// The unique index makes the first account to add a domain its only owner, even with two at once.
export async function addDomain({ account, domain: domainInput, archiveHost: archiveInput }) {
	const domain = normalizeDomainInput(domainInput);
	const domainProblem = getDomainProblem(domain, { isAdmin: (await findOwners(account._id)).some(isAdmin) });
	if (domainProblem) throw domainError(domainProblem);
	const archiveHost = normalizeHostInput(archiveInput) || `news.${domain}`;
	const archiveProblem = getArchiveHostProblem(archiveHost, domain);
	if (archiveProblem) throw domainError(archiveProblem);

	const provider = getEmailProvider();
	// Before the row: setting up a tenant links the account's domains, and the provider doesn't have this one yet.
	await provider.ensureTenant(account);
	let created;
	try {
		created = await insertRow("domains", {
			accountId: account._id,
			domain,
			archiveHost,
			mailFromDomain: provider.getMailFromDomain(domain),
			provider: provider.id,
		});
	} catch (error) {
		if (!isUniqueConstraint(error)) throw error;
		const isOwn = await getValue("SELECT 1 FROM domains WHERE accountId = ? AND domain = ?", [account._id, domain]);
		throw domainError(isOwn ? `${domain} is already added` : `${domain} is used by another MailCheap account`, "conflict");
	}

	try {
		const { providerDomainId } = await provider.addDomain({ account, domain });
		if (providerDomainId) await updateRows("domains", byId(account, created._id), { set: { providerDomainId } });
	} catch (error) {
		// Nothing was sent from it yet: the claim goes, so the account can try again.
		await execute("DELETE FROM domains WHERE accountId = ? AND _id = ?", [account._id, created._id]);
		throw error;
	}
	// The provider starts checking a new domain on its own: reading it is enough.
	return checkDomain({ account, domainId: created._id, verify: false });
}

// At the provider it was added at. One that isn't the active provider anymore may not be set up any longer.
export async function removeAtProvider({ account, domain }) {
	const active = getEmailProvider();
	const owner = getProvider(domain.provider ?? "ses") ?? active;
	try {
		await owner.removeDomain({ account, domain });
	} catch (error) {
		if (owner === active) throw error;
		console.error(`[domains] ${owner.name} didn't remove ${domain.domain}: ${error.message}`);
	}
}

export async function removeDomain({ account, domainId }) {
	const domain = await findDomain(account, domainId);
	const newsletterIds = (await getAll("SELECT _id, fromEmail FROM newsletters WHERE accountId = ?", [account._id]))
		.filter(({ fromEmail }) => getEmailDomain(fromEmail) === domain.domain)
		.map(({ _id }) => _id);
	const isInUse =
		newsletterIds.length > 0 &&
		Boolean(
			await getValue(
				`SELECT 1 FROM campaigns WHERE accountId = ? AND newsletterId IN (SELECT value FROM json_each(?))
				AND status IN (SELECT value FROM json_each(?)) LIMIT 1`,
				[account._id, JSON.stringify(newsletterIds), JSON.stringify(ACTIVE_CAMPAIGN_STATUSES)]
			)
		);
	if (isInUse) {
		throw domainError(`A campaign is sending or scheduled from ${domain.domain}. Wait until it's sent or cancel it first.`, "conflict");
	}

	await removeAtProvider({ account, domain });
	await execute("DELETE FROM domains WHERE accountId = ? AND _id = ?", [account._id, domain._id]);
	await syncArchiveHosts(account._id);
	return { removed: domain.domain };
}

// An account's purge: every domain at its provider. Its campaigns are gone already.
export async function releaseDomains(account) {
	for (const domain of await getAll("SELECT * FROM domains WHERE accountId = ?", [account._id])) {
		await removeAtProvider({ account, domain });
		await execute("DELETE FROM domains WHERE accountId = ? AND _id = ?", [account._id, domain._id]);
	}
}
