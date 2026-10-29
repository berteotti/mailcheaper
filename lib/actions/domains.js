import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { dateOutput, idInput, toIso } from "@/lib/actions/shared";
import { getNewsletterHost } from "@/lib/archive-hosts";
import { getAppHost, getArchiveCnameTarget, getSharedDomain } from "@/lib/config";
import { getAll } from "@/lib/db";
import { getDomainSetup, getDomainSummary } from "@/lib/domain-records";
import { addDomain, checkDomain, removeDomain } from "@/lib/domains";
import { getSharedAddress, isSharedSenderReady, withActiveProvider } from "@/lib/sender-rules";

const GROUP = "Domains";

const RecordSchema = z.object({ type: z.string(), name: z.string(), value: z.string() });
const DomainSchema = z.object({
	id: z.string(),
	domain: z.string(),
	status: z.string().describe("In words: Ready, Waiting for DNS…"),
	verified: z.boolean().describe("The email provider verified it: newsletters can send from it"),
	archiveHostVerified: z.boolean().describe("The archive subdomain points at MailCheap"),
	archiveHost: z.string(),
	mailFromDomain: z.string(),
	dkimStatus: z.string(),
	mailFromStatus: z.string(),
	setup: z
		.array(
			z.object({
				key: z.string(),
				title: z.string(),
				description: z.string(),
				status: z.string(),
				records: z.array(RecordSchema),
			})
		)
		.describe("The DNS records to add at the domain's DNS host, step by step"),
	checkedAt: dateOutput,
	verifiedAt: dateOutput,
	createdAt: dateOutput,
});

function toDomain(stored) {
	const domain = withActiveProvider(stored);
	return {
		id: String(domain._id),
		domain: domain.domain,
		status: getDomainSummary(domain, { cnameTarget: getArchiveCnameTarget() }).label,
		verified: Boolean(domain.verified),
		archiveHostVerified: Boolean(domain.archiveHostVerified),
		archiveHost: domain.archiveHost,
		mailFromDomain: domain.mailFromDomain,
		dkimStatus: domain.dkimStatus ?? "PENDING",
		mailFromStatus: domain.mailFromStatus ?? "PENDING",
		setup: getDomainSetup(domain, { cnameTarget: getArchiveCnameTarget(), appHost: getAppHost() }).map(({ key, title, description, status, records }) => ({
			key,
			title,
			description,
			status: status.label,
			records: records.map(({ type, name, value }) => ({ type, name, value })),
		})),
		checkedAt: toIso(domain.checkedAt),
		verifiedAt: toIso(domain.verifiedAt),
		createdAt: toIso(domain.createdAt),
	};
}

export const domainActions = [
	defineAction({
		name: "list_domains",
		tryWithoutPlan: true,
		title: "List domains",
		group: GROUP,
		description:
			"Lists the account's own sending domains with their DNS records and status as last checked, and each newsletter's shared address (hello@<slug>.<shared domain>), which works with no setup.",
		http: { method: "GET", path: "/domains" },
		readOnly: true,
		output: z.object({
			domains: z.array(DomainSchema),
			sharedDomain: z.string().nullable(),
			sharedAddresses: z
				.array(
					z.object({
						newsletterId: z.string(),
						newsletter: z.string(),
						fromEmail: z.string(),
						archiveHost: z.string().nullable(),
						ready: z.boolean().describe("Its subdomain is set up and verified: the newsletter can send from it"),
					})
				)
				.describe("Each newsletter's shared from address and archive host. Replies go to its reply-to, or to the organization's first owner."),
		}),
		handler: async ({ account }) => {
			const sharedDomain = getSharedDomain();
			const [domains, newsletters] = await Promise.all([
				getAll("SELECT * FROM domains WHERE accountId = ? ORDER BY createdAt, _id", [account._id]),
				getAll("SELECT _id, name, slug, archiveHost, sharedSender FROM newsletters WHERE accountId = ? ORDER BY createdAt, _id", [account._id]),
			]);
			return {
				domains: domains.map(toDomain),
				sharedDomain,
				sharedAddresses: sharedDomain
					? newsletters.map((newsletter) => ({
							newsletterId: String(newsletter._id),
							newsletter: newsletter.name,
							fromEmail: getSharedAddress(newsletter.slug, sharedDomain),
							archiveHost: getNewsletterHost(newsletter, sharedDomain),
							ready: isSharedSenderReady(newsletter, { sharedDomain }),
						}))
					: [],
			};
		},
	}),
	defineAction({
		name: "add_domain",
		title: "Add a domain",
		group: GROUP,
		description:
			"Adds a domain to send from, in the account's own tenant at the email provider: emails are signed with DKIM and bounces return to a subdomain of it (rp.<domain> on PostShiba, bounce.<domain> on Amazon SES). The answer lists the DNS records to add; check_domain reads them once they're in. Newsletters can send from it once it's verified.",
		http: { method: "POST", path: "/domains", status: 201 },
		openWorld: true,
		rateLimit: { limit: 10, window: "1 h" },
		example: { domain: "example.com" },
		input: z.object({
			domain: z
				.string()
				.trim()
				.max(253)
				.describe("e.g. example.com. An address or a link works too: jane@example.com and https://www.example.com/about both add example.com."),
			archiveHost: z
				.string()
				.trim()
				.max(253)
				.optional()
				.describe("Subdomain for the archive, tracked links and unsubscribe links. Default: news.<domain>."),
		}),
		output: DomainSchema,
		handler: async ({ account, input }) => toDomain(await addDomain({ account, domain: input.domain, archiveHost: input.archiveHost })),
	}),
	defineAction({
		name: "check_domain",
		title: "Check a domain's DNS records",
		group: GROUP,
		description:
			"Asks the email provider and DNS again whether the domain's records are in. On PostShiba, a check within a minute of the last one answers what that one found. Once its archive subdomain points at MailCheap, the newsletter sending from the domain moves its archive and links there.",
		http: { method: "POST", path: "/domains/{id}/check" },
		idempotent: true,
		openWorld: true,
		rateLimit: { limit: 60, window: "1 h" },
		input: z.object({ id: idInput("domain") }),
		output: DomainSchema,
		handler: async ({ account, input }) => toDomain(await checkDomain({ account, domainId: input.id })),
	}),
	defineAction({
		name: "remove_domain",
		tryWithoutPlan: true,
		title: "Remove a domain",
		group: GROUP,
		description:
			"Removes a domain from the email provider and its archive subdomain from MailCheap. Newsletters on it can't send until they move to another address. Refused while a campaign from it is sending, paused or scheduled. Adding it again needs new DNS records.",
		http: { method: "DELETE", path: "/domains/{id}" },
		destructive: true,
		idempotent: true,
		openWorld: true,
		input: z.object({ id: idInput("domain") }),
		output: z.object({ removed: z.string().describe("The domain that was removed") }),
		handler: ({ account, input }) => removeDomain({ account, domainId: input.id }),
	}),
];
