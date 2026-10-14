import "server-only";
import * as z from "zod";
import { defineAction } from "@/lib/actions/define-action";
import { UsageSchema, findFirstNewsletter, findNewsletter, getUsageOutput, newsletterInput } from "@/lib/actions/shared";
import { getEmailStats, getHourlySends, getSubscriberHistory } from "@/lib/overview-data";
import { PERIOD_DAYS } from "@/lib/overview-series";
import { resolveTimeZone } from "@/lib/time-zone";

const STAT_KEYS = ["sent", "delivered", "opened", "clicked", "bounced", "complained"];
const PeriodSchema = z.object({
	...Object.fromEntries(STAT_KEYS.map((key) => [key, z.number().int()])),
	rates: z
		.object({ delivered: z.number().nullable(), opened: z.number().nullable(), clicked: z.number().nullable(), bounced: z.number().nullable(), complained: z.number().nullable() })
		.describe("Fractions from 0 to 1: delivered, bounced and complained of sent; opened and clicked of delivered"),
});

function toRate(part, total) {
	return total ? Math.round((part / total) * 10_000) / 10_000 : null;
}

function toPeriod(stats) {
	const reached = stats.delivered || stats.sent;
	return {
		...Object.fromEntries(STAT_KEYS.map((key) => [key, stats[key] ?? 0])),
		rates: {
			delivered: toRate(stats.delivered, stats.sent),
			opened: toRate(stats.opened, reached),
			clicked: toRate(stats.clicked, reached),
			bounced: toRate(stats.bounced, stats.sent),
			complained: toRate(stats.complained, stats.sent),
		},
	};
}

// An account without a newsletter yet gets the plan's usage and nothing else.
function pickNewsletter(account, reference) {
	const fields = { name: 1, slug: 1 };
	return reference ? findNewsletter(account, reference, fields) : findFirstNewsletter(account, fields);
}

export const overviewActions = [
	defineAction({
		name: "get_overview",
		tryWithoutPlan: true,
		title: "Get the overview",
		group: "Overview",
		description: `The dashboard's overview for one newsletter: subscribers each day of the last ${PERIOD_DAYS} days, email results of the last ${PERIOD_DAYS} days against the ${PERIOD_DAYS} before, emails sent per hour today and yesterday, and the plan's usage this month, which the account's newsletters share.`,
		http: { method: "GET", path: "/overview" },
		readOnly: true,
		example: { timeZone: "Europe/Paris" },
		input: z.object({
			newsletter: newsletterInput,
			timeZone: z.string().max(64).optional().describe("IANA time zone for days and hours, e.g. Europe/Paris. Default: UTC."),
		}),
		output: z.object({
			newsletter: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
			timeZone: z.string(),
			subscribers: z
				.object({
					total: z.number().int(),
					growth: z.number().int().describe(`Change over the last ${PERIOD_DAYS} days`),
					previousGrowth: z.number().int().describe(`Change over the ${PERIOD_DAYS} days before`),
					days: z.array(z.object({ date: z.string(), total: z.number().int(), joined: z.number().int(), left: z.number().int() })),
				})
				.nullable(),
			emails: z.object({ current: PeriodSchema, previous: PeriodSchema }).nullable(),
			hours: z
				.array(z.object({ hour: z.number().int(), today: z.number().int().nullable(), yesterday: z.number().int() }))
				.nullable()
				.describe("Emails sent per hour; hours still to come today are null"),
			usage: UsageSchema,
		}),
		handler: async ({ account, input }) => {
			const timeZone = resolveTimeZone(input.timeZone);
			const [newsletter, usage] = await Promise.all([pickNewsletter(account, input.newsletter), getUsageOutput(account)]);
			if (!newsletter) return { newsletter: null, timeZone, subscribers: null, emails: null, hours: null, usage };

			const query = { accountId: account._id, newsletterId: newsletter._id, timeZone };
			const [history, stats, hours] = await Promise.all([getSubscriberHistory(query), getEmailStats(query), getHourlySends(query)]);
			return {
				newsletter: { id: String(newsletter._id), name: newsletter.name, slug: newsletter.slug },
				timeZone,
				subscribers: {
					total: history.total,
					growth: history.growth,
					previousGrowth: history.previousGrowth,
					days: history.current.map(({ key, total, joined, left }) => ({ date: key, total, joined, left })),
				},
				emails: { current: toPeriod(stats.current), previous: toPeriod(stats.previous) },
				hours,
				usage,
			};
		},
	}),
];
