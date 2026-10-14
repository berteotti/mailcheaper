import assert from "node:assert/strict";
import { describe, test } from "node:test";
import Papa from "papaparse";
import { mapColumns, normalizeDate, normalizeImportRow } from "../lib/csv-import.js";

// Each platform's subscriber export with the headers its docs (or open-source migration tools) show, read the
// way the import dialog reads a file. Addresses are made up.
function importFile(csv) {
	const { data, meta } = Papa.parse(csv.trim(), { header: true, skipEmptyLines: true });
	const columns = mapColumns(meta.fields);
	return { columns, rows: data.map((row) => normalizeImportRow(row, columns)) };
}

function statusesOf(rows) {
	return Object.fromEntries(rows.map(({ email, status }) => [email, status]));
}

describe("Beehiiv", () => {
	// Settings > Export Data, the columns TryGhost/migrate's Beehiiv members importer reads.
	test("reads status, created_at, and unsubscribed_at over an active status", () => {
		const { rows } = importFile(`
email,First Name,Last Name,status,tier,created_at,stripe_customer_id,Free Tier,unsubscribed_at
ada@example.com,Ada,,active,free,2023-03-24 10:23:10 UTC,,Yes,
ben@example.com,,,inactive,free,2023-03-24 10:36:48 UTC,,Yes,
cy@example.com,,,pending,free,2023-04-11 14:02:46 UTC,,Yes,
dee@example.com,,,validating,free,2023-04-11 14:02:46 UTC,,Yes,
eli@example.com,,,invalid,free,2023-04-11 14:02:46 UTC,,Yes,
fay@example.com,,,active,premium,2023-04-11 14:02:46 UTC,cus_1234,No,2024-03-13 11:33:53 UTC
gus@example.com,,,needs_attention,free,2023-04-11 14:02:46 UTC,,Yes,
`);
		assert.deepEqual(statusesOf(rows), {
			"ada@example.com": "active",
			"ben@example.com": "unsubscribed",
			"cy@example.com": "dormant",
			"dee@example.com": "dormant",
			"eli@example.com": "bounced",
			"fay@example.com": "unsubscribed",
			"gus@example.com": "dormant",
		});
		assert.equal(rows[0].subscribedAt, "2023-03-24T10:23:10.000Z");
	});

	// The API's subscription fields, with created in Unix seconds.
	test("reads a created date in Unix seconds", () => {
		const { rows } = importFile(`
id,email,status,created,subscription_tier,utm_source
sub_00000000-0000-0000-0000-000000000000,hal@example.com,active,1666800076,free,Twitter
`);
		assert.equal(rows[0].status, "active");
		assert.equal(rows[0].subscribedAt, new Date(1666800076 * 1000).toISOString());
	});
});

describe("Substack", () => {
	// Settings > Exports: the email list in the zip has no status, only email_disabled.
	test("leaves out readers whose emails are off", () => {
		const { rows } = importFile(`
email,active_subscription,expiry,plan,email_disabled,created_at,first_payment_at
ida@example.com,false,,other,false,2022-11-15T07:55:22.660Z,
jo@example.com,true,2027-01-04T23:26:30.533Z,paid,FALSE,2020-01-05T23:26:30.536Z,2020-01-05T23:30:00.000Z
kai@example.com,false,,other,TRUE,2018-12-19T08:03:04.977Z,
`);
		assert.deepEqual(statusesOf(rows), {
			"ida@example.com": "active",
			"jo@example.com": "active",
			"kai@example.com": "unsubscribed",
		});
		assert.equal(rows[0].subscribedAt, "2022-11-15T07:55:22.660Z");
	});

	// The subscribers page's export, with the columns Beehiiv's Substack guide lists.
	test("reads the subscribers page export and its start date", () => {
		const { rows } = importFile(`
Email,Name,Start date,Subscriber country,Subscription source (free),Activity
lea@example.com,Lea,2024-05-02,France,substack,4
`);
		assert.deepEqual(rows[0], {
			email: "lea@example.com",
			status: "active",
			subscribedAt: "2024-05-02T00:00:00.000Z",
			emailsReceived: undefined,
			openRate: undefined,
			clickRate: undefined,
		});
	});
});

describe("Mailchimp", () => {
	// Export audience gives a zip with one CSV per status and no status column (TryGhost/migrate's fixtures).
	const COMMON = "Email Address,First Name,Last Name,MEMBER_RATING,OPTIN_TIME,OPTIN_IP,CONFIRM_TIME,CONFIRM_IP,LATITUDE,LONGITUDE,GMTOFF,DSTOFF,TIMEZONE,CC,REGION";

	test("imports the subscribed file as active, with the opt-in time", () => {
		const { rows } = importFile(`
${COMMON},LAST_CHANGED,LEID,EUID,NOTES,TAGS
max@example.com,Max,,2,2023-04-21 11:16:57,,2023-04-21 11:16:57,,,,,,,,,2023-04-21 11:16:57,,,,"""Readers"""
`);
		assert.equal(rows[0].status, "active");
		assert.equal(rows[0].subscribedAt, "2023-04-21T11:16:57.000Z");
	});

	test("imports the unsubscribed file as unsubscribed and the cleaned file as bounced", () => {
		const unsubscribed = importFile(`
${COMMON},UNSUB_TIME,UNSUB_CAMPAIGN_TITLE,UNSUB_CAMPAIGN_ID,UNSUB_REASON,UNSUB_REASON_OTHER,LEID,EUID,NOTES,TAGS
nia@example.com,Nia,,,2018-02-12 10:54:27,,2018-02-12 10:54:27,,,,,,,,,2018-07-23 12:19:27,,,,,,,,
`);
		const cleaned = importFile(`
${COMMON},CLEAN_TIME,CLEAN_CAMPAIGN_TITLE,CLEAN_CAMPAIGN_ID,LEID,EUID,NOTES,TAGS
oz@example.com,,,1,2018-02-05 19:28:23,,2018-02-05 19:28:23,,,,,,,,,2020-03-23 17:30:05,,,,,,
`);
		assert.equal(unsubscribed.rows[0].status, "unsubscribed");
		assert.equal(cleaned.rows[0].status, "bounced");
	});
});

describe("Kit", () => {
	// Kit's help lists first name, email address, created date, status, tags and location; names as in its API.
	test("reads Kit's statuses and ignores the location's state column", () => {
		const { columns, rows } = importFile(`
first_name,email_address,created_at,status,tags,city,state,country
Pia,pia@example.com,2025-01-15T09:30:00Z,active,"Readers, VIP",Portland,OR,US
Quinn,quinn@example.com,2025-01-16T09:30:00Z,cancelled,,Portland,OR,US
Ray,ray@example.com,2025-01-17T09:30:00Z,bounced,,,,
Sam,sam@example.com,2025-01-18T09:30:00Z,complained,,,,
`);
		assert.equal(columns.status, "status");
		assert.deepEqual(statusesOf(rows), {
			"pia@example.com": "active",
			"quinn@example.com": "unsubscribed",
			"ray@example.com": "bounced",
			"sam@example.com": "complained",
		});
		assert.equal(rows[0].subscribedAt, "2025-01-15T09:30:00.000Z");
	});

	test("reads the statuses as the subscribers page names them", () => {
		const { rows } = importFile(`
Email address,First name,Status,Created at
tia@example.com,Tia,Confirmed,2025-02-01 08:00:00
uri@example.com,Uri,Unconfirmed,2025-02-01 08:00:00
vic@example.com,Vic,Unsubscribed,2025-02-01 08:00:00
wil@example.com,Wil,Cold,2025-02-01 08:00:00
xan@example.com,Xan,Blocked,2025-02-01 08:00:00
`);
		assert.deepEqual(statusesOf(rows), {
			"tia@example.com": "active",
			"uri@example.com": "dormant",
			"vic@example.com": "unsubscribed",
			"wil@example.com": "active",
			"xan@example.com": "unsubscribed",
		});
	});
});

describe("MailerLite", () => {
	// Statuses as MailerLite's API names them; junk is a spam complaint.
	test("reads active, unsubscribed, unconfirmed, bounced and junk", () => {
		const { rows } = importFile(`
email,name,last_name,status,subscribed_at
tom@example.com,Tom,,active,2026-01-01 12:00:00
una@example.com,Una,,unsubscribed,2026-01-02 12:00:00
val@example.com,Val,,unconfirmed,2026-01-03 12:00:00
wes@example.com,Wes,,bounced,2026-01-04 12:00:00
xia@example.com,Xia,,junk,2026-01-05 12:00:00
`);
		assert.deepEqual(statusesOf(rows), {
			"tom@example.com": "active",
			"una@example.com": "unsubscribed",
			"val@example.com": "dormant",
			"wes@example.com": "bounced",
			"xia@example.com": "complained",
		});
		assert.equal(rows[0].subscribedAt, "2026-01-01T12:00:00.000Z");
	});

	test("finds the email in a Subscriber column", () => {
		assert.equal(importFile("Subscriber,Name\nyul@example.com,Yul").rows[0].email, "yul@example.com");
	});
});

describe("Buttondown", () => {
	// docs.buttondown.com/data-exports-subscriber: the type sits in subscriber_type, not status.
	test("reads subscriber_type, with paying readers active", () => {
		const { columns, rows } = importFile(`
id,secondary_id,email,notes,subscriber_type,referrer_url,utm_source,utm_medium,utm_campaign,creation_date,ip_address,subscription_date,unsubscription_date,tags,metadata
1,1,liz@example.com,Met in NYC.,regular,,,,,2024-03-13 00:03:09.183465+00:00,192.0.2.1,2024-03-13 00:03:09.183465+00:00,,corporate;nyc,"{'staff': 'true'}"
2,2,max@example.com,,premium,,,,,2024-03-14 00:00:00+00:00,,2024-03-14 00:00:00+00:00,,,
3,3,ned@example.com,,unactivated,,,,,2024-03-15 00:00:00+00:00,,,,,
4,4,oli@example.com,,unsubscribed,,,,,2024-03-16 00:00:00+00:00,,2024-03-16 00:00:00+00:00,2024-04-08 17:09:32.596959+00:00,,
5,5,pat@example.com,,undeliverable,,,,,2024-03-17 00:00:00+00:00,,,,,
6,6,quin@example.com,,complained,,,,,2024-03-18 00:00:00+00:00,,,,,
7,7,rae@example.com,,removed,,,,,2024-03-19 00:00:00+00:00,,,,,
8,8,sid@example.com,,gifted,,,,,2024-03-20 00:00:00+00:00,,,,,
9,9,tess@example.com,,churned,,,,,2024-03-21 00:00:00+00:00,,,,,
10,10,uma@example.com,,paused,,,,,2024-03-22 00:00:00+00:00,,,,,
`);
		assert.equal(columns.status, "subscriber_type");
		assert.deepEqual(statusesOf(rows), {
			"liz@example.com": "active",
			"max@example.com": "active",
			"ned@example.com": "dormant",
			"oli@example.com": "unsubscribed",
			"pat@example.com": "bounced",
			"quin@example.com": "complained",
			"rae@example.com": "unsubscribed",
			"sid@example.com": "active",
			"tess@example.com": "active",
			"uma@example.com": "dormant",
		});
		assert.equal(rows[0].subscribedAt, "2024-03-13T00:03:09.183Z");
	});
});

describe("Ghost", () => {
	// Ghost's members exporter: no status column, subscribed_to_emails instead.
	test("imports members who get no newsletter as unsubscribed", () => {
		const { rows } = importFile(`
id,email,name,note,subscribed_to_emails,complimentary_plan,stripe_customer_id,created_at,deleted_at,labels,tiers,gift_id
6650a1b2c3d4e5f6a7b8c9d0,yan@example.com,Yan,,true,,,2025-06-01T09:30:00.000Z,,"vip, promotion",Free,
6650a1b2c3d4e5f6a7b8c9d1,zoe@example.com,Zoe,,false,true,cus_1234,2025-06-02T09:30:00.000Z,,,Premium,
`);
		assert.deepEqual(statusesOf(rows), { "yan@example.com": "active", "zoe@example.com": "unsubscribed" });
		assert.equal(rows[0].subscribedAt, "2025-06-01T09:30:00.000Z");
	});
});

describe("EmailOctopus", () => {
	// The export has the email address, first and last name, tags and custom fields; statuses as its API names them.
	test("reads the export of a status filter, and a Status column when there is one", () => {
		assert.equal(importFile("Email address,First name,Last name,Tags\nava@example.com,Ava,Ray,vip").rows[0].status, "active");

		const { rows } = importFile(`
Email address,First name,Last name,Status,Created at
bea@example.com,Bea,,SUBSCRIBED,2026-10-11T00:00:00+00:00
cal@example.com,Cal,,UNSUBSCRIBED,2026-10-11T00:00:00+00:00
dan@example.com,Dan,,PENDING,2026-10-11T00:00:00+00:00
`);
		assert.deepEqual(statusesOf(rows), { "bea@example.com": "active", "cal@example.com": "unsubscribed", "dan@example.com": "dormant" });
		assert.equal(rows[0].subscribedAt, "2026-10-11T00:00:00.000Z");
	});
});

test("a column that says someone left wins over the status, and nothing brings an unsubscribe back", () => {
	const columns = mapColumns(["email", "status", "subscribed_to_emails", "unsubscribed_at"]);
	assert.equal(normalizeImportRow({ email: "a@example.com", status: "unsubscribed", subscribed_to_emails: "true" }, columns).status, "unsubscribed");
	assert.equal(normalizeImportRow({ email: "b@example.com", status: "bounced", unsubscribed_at: "2024-01-01" }, columns).status, "bounced");
	assert.equal(normalizeImportRow({ email: "c@example.com", status: "active", subscribed_to_emails: "yes" }, columns).status, "active");
});

test("dates in the formats these exports use", () => {
	assert.equal(normalizeDate("2023-03-24 10:23:10 UTC"), "2023-03-24T10:23:10.000Z");
	assert.equal(normalizeDate("2024-03-13 00:03:09.183465+00:00"), "2024-03-13T00:03:09.183Z");
	assert.equal(normalizeDate("2018-02-12 10:54:27"), "2018-02-12T10:54:27.000Z");
	assert.equal(normalizeDate("2024-03-13 10:00:00 +0200"), "2024-03-13T08:00:00.000Z");
	assert.equal(normalizeDate("1666800076"), "2022-10-26T16:01:16.000Z");
	assert.equal(normalizeDate("1666800076000"), "2022-10-26T16:01:16.000Z");
	assert.equal(normalizeDate("2022-11-15T07:55:22.660Z"), "2022-11-15T07:55:22.660Z");
	assert.equal(normalizeDate(""), undefined);
	assert.equal(normalizeDate("soon"), undefined);
});
