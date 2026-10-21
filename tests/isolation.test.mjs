import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { accountIdOf, getAll, getOne, getValue } from "../lib/db.js";
import { insertRow } from "../lib/records.js";
import { activate, anonymous, as, callApi, catchRedirect, form, signIn, startTestApp } from "./helpers/app.mjs";
import { flushAfter } from "./stubs/next-server.mjs";
import { sent as sesEmails } from "./stubs/ses.mjs";

// Bob builds a newsletter with contacts, a campaign with a French edition, an API key and an upload through his own
// actions.
// Alice, signed in to her own paid account, then tries to reach each of them every way the app offers.
let app;
let alice;
let bob;
let bobData;
let m;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

async function createNewsletter(user, { name, slug }) {
	const url = await as(user, () =>
		catchRedirect(
			m.newsletters.saveNewsletter(
				null,
				form({ name, slug, fromName: name, fromEmail: `hello@${slug}.mailcheapmail.com`, postalAddress: "1 Main St, Paris" })
			)
		)
	);
	return url.split("/").at(-1);
}

async function createCampaign(user, newsletterId, subject) {
	const url = await as(user, () => catchRedirect(m.campaigns.createCampaign(newsletterId)));
	const id = url.split("/").at(-1);
	assert.deepEqual(await as(user, () => m.campaigns.saveCampaign(id, { subject, previewText: "Hi", body: "<p>Hello readers</p>" })), {
		ok: true,
	});
	return id;
}

async function upload(user) {
	const request = new Request("http://localhost:3000/api/uploads", {
		method: "POST",
		headers: { "content-type": "image/png", "x-file-name": "cover" },
		body: PNG,
	});
	return as(user, () => m.uploadsRoute.POST(request));
}

async function snapshot() {
	const [newsletter, campaign, editions, contacts, apiKey, uploads] = await Promise.all([
		getOne("SELECT * FROM newsletters WHERE accountId = ? AND _id = ?", [bob.accountId, bobData.newsletterId]),
		getOne("SELECT * FROM campaigns WHERE accountId = ? AND _id = ?", [bob.accountId, bobData.campaignId]),
		getAll("SELECT * FROM campaign_editions WHERE accountId = ? ORDER BY language", [bob.accountId]),
		getAll("SELECT * FROM contacts WHERE accountId = ? ORDER BY email", [bob.accountId]),
		getOne("SELECT * FROM api_keys WHERE accountId = ?", [bob.accountId]),
		getAll("SELECT * FROM uploads WHERE accountId = ?", [bob.accountId]),
	]);
	return JSON.parse(JSON.stringify({ newsletter, campaign, editions, contacts, apiKey, uploads }));
}

before(async () => {
	app = await startTestApp();
	m = {
		newsletters: await import("../app/(app)/newsletters/actions.js"),
		campaigns: await import("../app/(app)/campaigns/actions.js"),
		contacts: await import("../app/(app)/contacts/actions.js"),
		apiKeys: await import("../app/(app)/api-keys/actions.js"),
		uploadsRoute: await import("../app/api/uploads/route.js"),
		contactQueries: await import("../lib/contacts.js"),
		campaignQueries: await import("../lib/campaign-queries.js"),
		apiKeyQueries: await import("../lib/api-keys.js"),
		usage: await import("../lib/usage.js"),
	};

	alice = await signIn("alice@example.com");
	bob = await signIn("bob@example.com");
	await activate(alice);
	await activate(bob);

	const newsletterId = await createNewsletter(bob, { name: "Bob weekly", slug: "bob-weekly" });
	const imported = await as(bob, () =>
		m.contacts.importContacts({
			newsletterId,
			consent: true,
			rows: [
				{ email: "reader1@example.org", status: "active" },
				{ email: "reader2@example.org", status: "active" },
				{ email: "cold@example.org", status: "dormant" },
			],
		})
	);
	assert.equal(imported.created, 3);
	const campaignId = await createCampaign(bob, newsletterId, "Bob's issue");
	assert.deepEqual(
		await as(bob, () => m.campaigns.saveCampaignEdition(campaignId, "fr", { subject: "Le numéro de Bob", previewText: "", body: "<p>Bonjour</p>" })),
		{ ok: true }
	);
	const { key: apiKey } = await as(bob, () => m.apiKeys.createApiKey(null, form({ name: "Bob's site" })));
	const uploaded = await upload(bob);
	assert.equal(uploaded.status, 200);
	const reader = await getOne("SELECT * FROM contacts WHERE accountId = ? AND email = 'reader1@example.org'", [bob.accountId]);
	const dormant = await getOne("SELECT * FROM contacts WHERE accountId = ? AND email = 'cold@example.org'", [bob.accountId]);
	const apiKeyId = (await getOne("SELECT _id FROM api_keys WHERE accountId = ?", [bob.accountId]))._id;
	bobData = {
		newsletterId,
		campaignId,
		apiKey,
		apiKeyId,
		readerId: reader._id.toString(),
		dormantId: dormant._id.toString(),
		uploadUrl: (await uploaded.json()).url,
	};

	await createNewsletter(alice, { name: "Alice letters", slug: "alice-letters" });
	alice.apiKey = (await as(alice, () => m.apiKeys.createApiKey(null, form({ name: "Alice's site" })))).key;
});

after(() => app?.stop());

describe("server actions refuse another account's data", () => {
	test("newsletters: update, welcome test, new campaign, contact import, adding a contact", async () => {
		const before = await snapshot();
		const update = await as(alice, () =>
			m.newsletters.saveNewsletter(
				null,
				form({
					id: bobData.newsletterId,
					name: "Taken",
					slug: "bob-weekly",
					fromEmail: "attacker@example.com",
					postalAddress: "Nowhere",
				})
			)
		);
		assert.deepEqual(update, { error: "Newsletter not found" });
		assert.match((await as(alice, () => m.newsletters.sendWelcomeTest(bobData.newsletterId))).error, /Newsletter not found/);
		assert.deepEqual(await as(alice, () => m.campaigns.createCampaign(bobData.newsletterId)), { error: "Newsletter not found" });
		assert.deepEqual(
			await as(alice, () =>
				m.contacts.importContacts({ newsletterId: bobData.newsletterId, rows: [{ email: "spam@example.net", status: "active" }] })
			),
			{ error: "Newsletter not found" }
		);
		assert.deepEqual(
			await as(alice, () => m.contacts.addContact(null, form({ newsletterId: bobData.newsletterId, email: "spam@example.net", consent: "on" }))),
			{ error: "Newsletter not found" }
		);
		assert.deepEqual(await snapshot(), before);
		assert.equal(await getValue("SELECT count(*) FROM contacts WHERE accountId = ? AND email = 'spam@example.net'", [bob.accountId]), 0);
		assert.equal(await getValue("SELECT count(*) FROM contacts WHERE newsletterId = ? AND email = 'spam@example.net'", [bobData.newsletterId]), 0);
	});

	test("campaigns: every action answers not found and changes nothing", async () => {
		const before = await snapshot();
		const id = bobData.campaignId;
		const attempts = {
			saveCampaign: () => m.campaigns.saveCampaign(id, { subject: "Hacked", previewText: "", body: "<p>x</p>" }),
			sendTestCampaign: () => m.campaigns.sendTestCampaign(id),
			sendTestEdition: () => m.campaigns.sendTestCampaign(id, "fr"),
			saveCampaignEdition: () => m.campaigns.saveCampaignEdition(id, "fr", { subject: "Piraté", previewText: "", body: "<p>x</p>" }),
			addCampaignEdition: () => m.campaigns.addCampaignEdition(id, "de"),
			deleteCampaignEdition: () => m.campaigns.deleteCampaignEdition(id, "fr"),
			setCampaignLanguage: () => m.campaigns.setCampaignLanguage(id, "es"),
			sendCampaign: () => m.campaigns.sendCampaign(id, {}),
			scheduleCampaign: () => m.campaigns.scheduleCampaign(id, { scheduledAt: new Date(Date.now() + 86_400_000).toISOString() }),
			unscheduleCampaign: () => m.campaigns.unscheduleCampaign(id),
			sendCampaignToMore: () => m.campaigns.sendCampaignToMore(id, {}),
			resumeCampaign: () => m.campaigns.resumeCampaign(id),
			pauseCampaign: () => m.campaigns.pauseCampaign(id),
			toggleArchivePin: () => m.campaigns.toggleArchivePin(id),
			duplicateCampaign: () => m.campaigns.duplicateCampaign(id),
			discardCampaign: () => m.campaigns.discardCampaign(id),
			updateArchiveSlug: () => m.campaigns.updateArchiveSlug(id, "stolen"),
			previewCleanup: () => m.campaigns.previewCleanup(id),
		};
		const emailsBefore = sesEmails.length;
		for (const [name, attempt] of Object.entries(attempts)) {
			const result = await as(alice, attempt);
			assert.equal(result?.error, "Campaign not found", name);
		}
		assert.equal(sesEmails.length, emailsBefore, "no test email went out");
		assert.equal(await getValue("SELECT count(*) FROM campaigns WHERE accountId = ?", [alice.accountId]), 0, "no copy landed in Alice's account");
		assert.equal(await getValue("SELECT count(*) FROM campaign_editions WHERE accountId = ?", [alice.accountId]), 0);
		assert.deepEqual(await snapshot(), before);
	});

	test("contacts: status changes", async () => {
		const before = await snapshot();
		assert.deepEqual(await as(alice, () => m.contacts.setContactStatus(bobData.readerId, "unsubscribed")), {
			error: "Contact not found",
		});
		assert.deepEqual(await as(alice, () => m.contacts.setContactStatus(bobData.dormantId, "active")), {
			error: "Contact not found",
		});
		assert.deepEqual(await snapshot(), before);
	});

	test("API keys: revoking", async () => {
		const before = await snapshot();
		assert.deepEqual(await as(alice, () => m.apiKeys.revokeApiKey(bobData.apiKeyId)), { error: "Key not found" });
		assert.deepEqual(await snapshot(), before);
		const stillWorks = await callApi("GET", "/api/v1/campaigns?newsletter=bob-weekly", { key: bobData.apiKey });
		assert.equal(stillWorks.status, 200);
	});
});

describe("lists only show the account's own data", () => {
	test("newsletters, contacts, campaigns, API keys and uploads", async () => {
		const aliceAccount = { _id: alice.accountId };
		const newsletters = await m.contactQueries.listNewslettersWithActiveCounts(aliceAccount);
		assert.deepEqual(newsletters.map(({ slug }) => slug), ["alice-letters"]);

		const everything = await m.contactQueries.findContactsPage(aliceAccount, {});
		assert.equal(everything.totalAll, 0);
		const filtered = await m.contactQueries.findContactsPage(aliceAccount, { newsletterId: bobData.newsletterId });
		assert.equal(filtered.totalAll, 0, "naming Bob's newsletter in the filter shows nothing");
		const searched = await m.contactQueries.findContactsPage(aliceAccount, { query: "reader" });
		assert.equal(searched.contacts.length, 0);

		const campaigns = await m.campaignQueries.listRecentCampaigns({ accountId: alice.accountId, limit: 200 });
		assert.equal(campaigns.length, 0);

		const keys = await m.apiKeyQueries.listApiKeys(aliceAccount);
		assert.deepEqual(keys.map(({ name }) => name), ["Alice's site"]);
		assert.equal(keys[0].hash, undefined, "the hash never reaches a page");

		assert.equal(await getValue("SELECT count(*) FROM uploads WHERE accountId = ?", [aliceAccount._id]), 0);
		const usage = await m.usage.getUsage(alice.account);
		assert.equal(usage.subscribers, 0, "Bob's contacts don't count toward Alice's plan");
	});

	test("uploads land in the uploader's folder, and the route needs a paid session", async () => {
		const [bobUpload] = await getAll("SELECT * FROM uploads WHERE accountId = ?", [bob.accountId]);
		assert.ok(bobUpload.pathname.startsWith(`accounts/${bob.accountId}/images/`));
		assert.ok(bobData.uploadUrl.includes(`accounts/${bob.accountId}/`));

		const aliceUpload = await upload(alice);
		assert.equal(aliceUpload.status, 200);
		const aliceUrl = (await aliceUpload.json()).url;
		assert.ok(aliceUrl.includes(`accounts/${alice.accountId}/`));
		assert.equal(await getValue("SELECT count(*) FROM uploads WHERE accountId = ?", [bob.accountId]), 1, "Bob still has his one upload");
		const library = await as(alice, () => m.uploadsRoute.GET(new Request("http://localhost:3000/api/uploads")));
		assert.deepEqual((await library.json()).images.map(({ url }) => url), [aliceUrl], "the picker shows Alice's image, not Bob's");

		const signedOut = await anonymous(() =>
			m.uploadsRoute.POST(new Request("http://localhost:3000/api/uploads", { method: "POST", headers: { "content-type": "image/png" }, body: PNG }))
		);
		assert.equal(signedOut.status, 401);
	});
});

describe("API routes stay inside the key's account", () => {
	test("signing a contact up into another account's newsletter", async () => {
		const response = await callApi("POST", "/api/v1/contacts", {
			key: alice.apiKey,
			body: { newsletter: "bob-weekly", email: "intruder@example.net" },
		});
		assert.equal(response.status, 404);
		assert.deepEqual(response.body, { error: { code: "not_found", message: "Newsletter not found" } });
		assert.equal(await getValue("SELECT count(*) FROM contacts WHERE email = 'intruder@example.net'"), 0);

		const own = await callApi("POST", "/api/v1/contacts", { key: bobData.apiKey, body: { newsletter: "bob-weekly", email: "fan@example.net" } });
		assert.equal(own.status, 201);
		await flushAfter();
		const fan = await getOne("SELECT * FROM contacts WHERE accountId = ? AND email = 'fan@example.net'", [bob.accountId]);
		assert.equal(String(fan.newsletterId), bobData.newsletterId);
	});

	test("reading and drafting campaigns", async () => {
		const read = await callApi("GET", "/api/v1/campaigns?newsletter=bob-weekly", { key: alice.apiKey });
		assert.equal(read.status, 404);

		const draft = await callApi("POST", "/api/v1/campaigns", {
			key: alice.apiKey,
			body: { newsletter: "bob-weekly", subject: "Injected", format: "html", content: "<p>x</p>" },
		});
		assert.equal(draft.status, 404);
		assert.equal(await getValue("SELECT count(*) FROM campaigns WHERE accountId = ?", [bob.accountId]), 1);

		const before = await snapshot();
		const path = `/api/v1/campaigns/${bobData.campaignId}/editions/fr`;
		assert.equal((await callApi("PATCH", path, { key: alice.apiKey, body: { subject: "Piraté" } })).status, 404);
		assert.equal((await callApi("DELETE", path, { key: alice.apiKey })).status, 404);
		assert.equal((await callApi("GET", `/api/v1/campaigns/${bobData.campaignId}`, { key: alice.apiKey })).status, 404);
		assert.deepEqual(await snapshot(), before);
	});

	test("an unknown or revoked key gets 401", async () => {
		const unknown = await callApi("POST", "/api/v1/contacts", {
			key: `mc_${"x".repeat(43)}`,
			body: { newsletter: "bob-weekly", email: "x@example.net" },
		});
		assert.equal(unknown.status, 401);
	});
});

describe("the scope guard", () => {
	test("customer data can't be written without an account", async () => {
		await assert.rejects(insertRow("contacts", { newsletterId: bobData.newsletterId, email: "orphan@example.org" }), /accountId/);
		await assert.rejects(
			insertRow("campaigns", { accountId: "000000000000000000000000", newsletterId: bobData.newsletterId, subject: "Orphan" }),
			/FOREIGN KEY/,
			"nor with an account that doesn't exist"
		);
		await assert.rejects(insertRow("uploads", { url: "https://x.test/a.png", pathname: "a.png", contentType: "image/png", bytes: 1 }), /accountId/);
	});

	test("queries are scoped by an account id, for webhooks and signed links too", async () => {
		const found = await getOne("SELECT accountId FROM campaigns WHERE _id = ?", [bobData.campaignId]);
		assert.equal(found.accountId, bob.accountId);
		assert.throws(() => accountIdOf(undefined), /No account to scope/);
		assert.equal(accountIdOf({ _id: String(bob.accountId) }), String(bob.accountId));
	});
});
