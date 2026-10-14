import "server-only";
import { hasActiveSubscription } from "@/lib/account-state";
import { sendAlert } from "@/lib/alerts";
import { getAppHost, getArchiveCnameTarget, getSharedDomain } from "@/lib/config";
import { getAll, getOne } from "@/lib/db";
import { removeAtProvider } from "@/lib/domains";
import { getEmailProvider, getProvider } from "@/lib/email-provider";
import { isReservedSlug } from "@/lib/reserved-slugs";
import { publishSharedRecords, removeSharedRecords } from "@/lib/dns-broker";
import { updateRows } from "@/lib/records";
import { getSharedSendingDomain, isOnSharedDomain } from "@/lib/sender-rules";

// A newsletter on the shared address sends from hello@<slug>.SHARED_DOMAIN: a sending domain in its account's
// tenant at the email provider (a domain belongs to one tenant), with its DNS records published on SHARED_DOMAIN
// by the DNS helper. It follows the slug, like the archive at <slug>.SHARED_DOMAIN.
const CHECK_EVERY_MS = 60_000;

function byId(account, newsletter) {
	return { where: "accountId = ? AND _id = ?", params: [account._id, String(newsletter._id)] };
}

// Only while the newsletter still has this subdomain: a save in between may have moved it.
function withSharedDomain(account, newsletter, sharedSender) {
	return {
		where: "accountId = ? AND _id = ? AND json_extract(sharedSender, '$.domain') = ?",
		params: [account._id, String(newsletter._id), sharedSender.domain],
	};
}

function isRecent(date) {
	return Boolean(date) && Date.now() - new Date(date).getTime() < CHECK_EVERY_MS;
}

// The provider's records, and one for the subdomain itself: with records under it, a wildcard on the shared
// domain no longer answers for it, and its archive and links have to keep resolving. Without ARCHIVE_CNAME_TARGET,
// it points at the app's own host on Cloudflare.
function getRecords(domain, status) {
	return [...status.records, { purpose: "web", type: "CNAME", name: domain, value: getArchiveCnameTarget() ?? getAppHost().split(":")[0] }];
}

// The slug the records were published for, which may not be the newsletter's any longer.
function getRecordSlug(sharedSender) {
	return sharedSender.domain.split(".")[0];
}

async function unpublish(sharedSender) {
	await removeSharedRecords(getRecordSlug(sharedSender), sharedSender.dnsRecordIds).catch((error) =>
		console.error(`[shared-sender] ${sharedSender.domain}'s DNS records stay: ${error.message}`)
	);
}

// Without the DNS helper nothing is published: fine in development, where nothing verifies anyway. In
// production it's an error, so the subdomain is set up again once the helper is there.
async function publish(slug, records) {
	const { ids, skipped } = await publishSharedRecords(slug, records);
	if (skipped && process.env.NODE_ENV === "production") throw new Error(`the DNS helper isn't set up, so ${slug}'s records can't be published`);
	return ids ?? [];
}

async function create({ account, newsletter, zone, provider }) {
	const domain = getSharedSendingDomain(newsletter.slug, zone);
	const { providerDomainId = null, status: created } = await provider.addDomain({ account, domain });
	const status = created ?? (await provider.readDomain({ account, domain: { domain, providerDomainId } }));
	if (status.error || status.missing) throw new Error(`${provider.name} didn't return ${domain}'s records: ${status.error ?? "not found"}`);
	const dnsRecordIds = await publish(newsletter.slug, getRecords(domain, status));
	const sharedSender = { domain, provider: provider.id, providerDomainId, verified: Boolean(status.verified), dnsRecordIds, createdAt: new Date() };
	await updateRows("newsletters", byId(account, newsletter), { set: { sharedSender } });
	return sharedSender;
}

// At the provider it was set up at, and its records. A provider that isn't the active one may not be set up
// any longer: what stays there is reported.
async function remove({ account, newsletter, sharedSender }) {
	await updateRows("newsletters", withSharedDomain(account, newsletter, sharedSender), { unset: ["sharedSender"] });
	const provider = getProvider(sharedSender.provider) ?? getEmailProvider();
	try {
		await provider.removeDomain({ account, domain: sharedSender });
	} catch (error) {
		console.error(`[shared-sender] ${provider.name} still has ${sharedSender.domain}: ${error.message}`);
		await sendAlert({
			accountId: null,
			key: `shared-sender-left:${sharedSender.domain}`,
			title: "Old sending subdomain left behind",
			detail: `${sharedSender.domain} (account ${account._id}) is still at ${provider.name}: ${error.message}. Remove it there before another newsletter takes the slug.`,
			path: "/admin",
		});
	}
	await unpublish(sharedSender);
}

// After a newsletter is saved: the sending subdomain for its slug at the active provider, while it uses the
// shared address. One for another slug or provider goes, so a slug given up can be taken by someone else.
// Failures are reported and retried at the next send, never thrown: the newsletter is saved either way.
// Before the provider's keys are in, the expected state of a new server, nothing is tried: the Domains page says so.
// An account without a plan gets nothing at the provider or in DNS until its plan starts (syncSharedSenders).
export async function syncSharedSender({ account, newsletter }) {
	const zone = getSharedDomain();
	if (!zone) return null;
	const current = newsletter.sharedSender?.domain ? newsletter.sharedSender : null;
	try {
		const provider = getEmailProvider();
		if (!provider.isConfigured()) return null;
		if (current?.domain === getSharedSendingDomain(newsletter.slug, zone) && current.provider === provider.id) return current;
		if (current) await remove({ account, newsletter, sharedSender: current });
		const isWanted = isOnSharedDomain(newsletter.fromEmail, zone) && !isReservedSlug(newsletter.slug) && hasActiveSubscription(account);
		return isWanted ? await create({ account, newsletter, zone, provider }) : null;
	} catch (error) {
		console.error(`[shared-sender] ${newsletter.slug}: ${error.message}`);
		await sendAlert({
			accountId: null,
			key: `shared-sender-failed:${newsletter._id}`,
			title: "Shared address not set up",
			detail: `${getSharedSendingDomain(newsletter.slug, zone)} (account ${account._id}): ${error.message}. The newsletter's next send tries again.`,
			path: "/admin",
		});
		return null;
	}
}

// An account's purge: each shared address's subdomain at its provider, then the records the DNS helper published
// for it. A failure throws, so the purge tries again while the newsletter still has the record ids.
export async function releaseSharedSenders(account) {
	const newsletters = await getAll(
		"SELECT _id, sharedSender FROM newsletters WHERE accountId = ? AND json_type(sharedSender, '$.domain') = 'text'",
		[account._id]
	);
	for (const newsletter of newsletters) {
		const { sharedSender } = newsletter;
		await removeAtProvider({ account, domain: sharedSender });
		await removeSharedRecords(getRecordSlug(sharedSender), sharedSender.dnsRecordIds);
		await updateRows("newsletters", byId(account, newsletter), { unset: ["sharedSender"] });
	}
}

// When a plan starts, for the newsletters set up before it.
export async function syncSharedSenders(account) {
	const newsletters = await getAll("SELECT * FROM newsletters WHERE accountId = ? ORDER BY createdAt, _id", [account._id]);
	for (const newsletter of newsletters) await syncSharedSender({ account, newsletter });
}

// Before a send: the newsletter with its sending subdomain set up and, until it verifies, checked again at
// most once a minute. Reading doesn't use the provider's verification budget; the provider keeps checking on its own.
export async function refreshSharedSender(account, newsletter) {
	const zone = getSharedDomain();
	if (!isOnSharedDomain(newsletter?.fromEmail, zone)) return newsletter;
	const stored = await getOne("SELECT _id, slug, fromEmail, sharedSender FROM newsletters WHERE accountId = ? AND _id = ?", [
		account._id,
		String(newsletter._id),
	]);
	if (!stored) return newsletter;
	let sharedSender = await syncSharedSender({ account, newsletter: stored });
	if (!sharedSender || sharedSender.verified || isRecent(sharedSender.checkedAt)) return { ...newsletter, sharedSender };

	const status = await getEmailProvider().readDomain({ account, domain: sharedSender });
	// Gone at the provider: the next send sets it up again.
	if (status.missing) {
		await remove({ account, newsletter: stored, sharedSender });
		return { ...newsletter, sharedSender: null };
	}
	const checkedAt = new Date();
	const isVerified = Boolean(status.verified);
	await updateRows("newsletters", withSharedDomain(account, newsletter, sharedSender), {
		set: { "sharedSender.verified": isVerified, "sharedSender.checkedAt": checkedAt, ...(isVerified && { "sharedSender.verifiedAt": checkedAt }) },
	});
	sharedSender = { ...sharedSender, verified: isVerified, checkedAt };
	return { ...newsletter, sharedSender };
}
