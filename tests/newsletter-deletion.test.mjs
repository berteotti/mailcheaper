import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { getOne, getValue } from "../lib/db.js";
import { insertRow } from "../lib/records.js";
import { activate, as, callApi, catchRedirect, findAccount, form, signIn, startTestApp, withEnv } from "./helpers/app.mjs";

// A newsletter goes for good with everything it holds, and nothing of the account's other newsletters or its
// suppressions. Its recent emails keep it until they no longer count toward the account's rates (MailCheap Cloud).
let app;
let m;

const DAY_MS = 24 * 60 * 60 * 1000;
const NEWSLETTER_TABLES = ["contacts", "contact_imports", "campaigns", "messages"];

async function createNewsletter(user, slug) {
	const url = await as(user, () =>
		catchRedirect(m.newsletters.saveNewsletter(null, form({ name: `${slug} news`, slug, postalAddress: "1 Main St, Paris" })))
	);
	return url.split("/").at(-1);
}

async function customer(email) {
	const user = await signIn(email);
	await activate(user);
	user.key = (await as(user, () => m.apiKeys.createApiKey(null, form({ name: "Agent", level: "full" })))).key;
	return user;
}

function api(key, method, path, body) {
	return callApi(method, `/api/v1${path}`, { key, body });
}

// A sent issue with one recipient and its delivery event, sent daysAgo.
async function sentIssue(user, newsletterId, { daysAgo, kind = "campaign", email = "reader@example.org" }) {
	const sentAt = new Date(Date.now() - daysAgo * DAY_MS);
	const contact =
		(await getOne("SELECT * FROM contacts WHERE accountId = ? AND newsletterId = ? AND email = ?", [user.accountId, newsletterId, email])) ??
		(await insertRow("contacts", { accountId: user.accountId, newsletterId, email, subscribedAt: sentAt }));
	const campaign = await insertRow("campaigns", { accountId: user.accountId, newsletterId, subject: "Issue", status: "sent", sentAt });
	const message = await insertRow("messages", {
		accountId: user.accountId,
		kind,
		campaignId: kind === "campaign" ? campaign._id : null,
		newsletterId,
		contactId: contact._id,
		email,
		status: "delivered",
		sentAt,
		deliveredAt: sentAt,
	});
	await insertRow("events", { accountId: user.accountId, type: "Delivery", messageId: message._id, campaignId: campaign._id, occurredAt: sentAt });
	return { campaign, message };
}

function countRows(table, newsletterId) {
	return getValue(`SELECT count(*) FROM ${table} WHERE newsletterId = ?`, [newsletterId]);
}

before(async () => {
	app = await startTestApp();
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		deletion: await import("../lib/newsletter-deletion.js"),
	};
});

after(() => app?.stop());

describe("deleting a newsletter", () => {
	test("takes its contacts, imports, campaigns, messages and events, and nothing of the other newsletter's", async () => {
		const user = await customer("deletes@example.com");
		const kept = await createNewsletter(user, "deletes-kept");
		const gone = await createNewsletter(user, "deletes-gone");
		for (const newsletterId of [kept, gone]) {
			const imported = await as(user, () =>
				m.contacts.importContacts({
					newsletterId,
					consent: true,
					rows: [{ email: `ann-${newsletterId}@example.org`, status: "active" }, { email: "gone@example.org", status: "bounced" }],
				})
			);
			assert.equal(imported.created, 2);
			await sentIssue(user, newsletterId, { daysAgo: 10 });
		}

		const deleted = await api(user.key, "DELETE", "/newsletters/deletes-gone");
		assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
		assert.deepEqual(deleted.body, { id: gone, deleted: true });
		for (const table of NEWSLETTER_TABLES) {
			assert.equal(await countRows(table, gone), 0, table);
			assert.ok((await countRows(table, kept)) > 0, `${table} of the other newsletter`);
		}
		assert.equal(await getValue("SELECT count(*) FROM events WHERE accountId = ?", [user.accountId]), 1, "the other newsletter's event");
		assert.equal(
			(await getOne("SELECT reason FROM suppressions WHERE accountId = ? AND email = ?", [user.accountId, "gone@example.org"])).reason,
			"bounce",
			"the account's suppressions stay"
		);
		assert.equal((await api(user.key, "GET", "/newsletters/deletes-gone")).status, 404);
		assert.equal((await api(user.key, "DELETE", "/newsletters/deletes-gone")).status, 404);
		assert.ok(await createNewsletter(user, "deletes-gone"), "its slug is free again");
	});

	test("waits for its campaigns to stop, and on MailCheap Cloud for its emails of the last 7 days to stop counting", async () => {
		const user = await customer("deletes-later@example.com");
		const newsletterId = await createNewsletter(user, "deletes-later");
		const campaign = await insertRow("campaigns", {
			accountId: user.accountId,
			newsletterId,
			subject: "Next week",
			status: "scheduled",
			scheduledAt: new Date(Date.now() + DAY_MS),
		});
		const scheduled = await api(user.key, "DELETE", `/newsletters/${newsletterId}`);
		assert.equal(scheduled.status, 409);
		assert.equal(scheduled.body.error.message, "Pause or unschedule its campaigns first: Next week");
		await getOne("UPDATE campaigns SET status = 'draft', scheduledAt = NULL WHERE _id = ? RETURNING _id", [campaign._id]);

		await sentIssue(user, newsletterId, { daysAgo: 8 });
		await sentIssue(user, newsletterId, { daysAgo: 1, kind: "test", email: "deletes-later@example.com" });
		const { message } = await sentIssue(user, newsletterId, { daysAgo: 2, kind: "welcome", email: "new@example.org" });
		const recent = await api(user.key, "DELETE", `/newsletters/${newsletterId}`);
		assert.equal(recent.status, 409);
		const availableAt = new Date(message.sentAt.getTime() + 7 * DAY_MS);
		const date = availableAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
		assert.equal(
			recent.body.error.message,
			`It sent emails in the last 7 days, which still count toward your bounce and complaint rates. You can delete it from ${date}.`,
			"a welcome email counts, a test email doesn't"
		);

		const account = await findAccount(user.accountId);
		const newsletter = await getOne("SELECT * FROM newsletters WHERE _id = ?", [newsletterId]);
		assert.equal(
			await withEnv({ MAILCHEAP_CLOUD: "false" }, () => m.deletion.getNewsletterDeletionBlockers(account, newsletter)),
			null,
			"a self-hosted server's users are its admins' own"
		);
		await getOne("UPDATE messages SET sentAt = ? WHERE newsletterId = ? RETURNING _id", [Date.now() - 8 * DAY_MS, newsletterId]);
		assert.equal((await api(user.key, "DELETE", `/newsletters/${newsletterId}`)).status, 200);
	});

	test("on the dashboard, takes the newsletter's name typed out, then opens the account's first newsletter", async () => {
		const user = await customer("deletes-dashboard@example.com");
		await createNewsletter(user, "deletes-first");
		const newsletterId = await createNewsletter(user, "deletes-second");
		assert.deepEqual(await as(user, () => m.newsletters.deleteNewsletter(newsletterId, "deletes-second")), {
			error: "Type the newsletter's name to delete it",
		});
		assert.equal(await as(user, () => catchRedirect(m.newsletters.deleteNewsletter(newsletterId, " deletes-second news "))), "/");
		assert.equal(await getValue("SELECT count(*) FROM newsletters WHERE _id = ?", [newsletterId]), 0);
	});

	test("an account deletes 3 newsletters a day", async () => {
		const user = await customer("deletes-many@example.com");
		await createNewsletter(user, "deletes-many");
		for (let round = 1; round <= 4; round++) {
			const newsletterId = await createNewsletter(user, `deletes-many-${round}`);
			const response = await api(user.key, "DELETE", `/newsletters/${newsletterId}`);
			if (round <= 3) assert.equal(response.status, 200, `deletion ${round}`);
			else assert.equal(response.body.error.message, "You can delete 3 newsletters a day. Try again later.");
		}
	});
});
