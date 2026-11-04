import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { getDmarcHosts, getDmarcStatus } from "../lib/dmarc-rules.js";
import { readTxt } from "../lib/dns-check.js";
import { getDomainSetup } from "../lib/domain-records.js";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

test("DMARC is looked up on the domain, then on its parents down to the registrable domain, from four labels at most", () => {
	assert.deepEqual(getDmarcHosts("example.com"), ["example.com"]);
	assert.deepEqual(getDmarcHosts("news.example.com"), ["news.example.com", "example.com"]);
	assert.deepEqual(getDmarcHosts("mail.example.co.uk"), ["mail.example.co.uk", "example.co.uk"]);
	assert.deepEqual(getDmarcHosts("example.co.za"), ["example.co.za"], "co.za's own record isn't the domain's");
	assert.deepEqual(getDmarcHosts("a.b.c.d.example.com"), ["a.b.c.d.example.com", "c.d.example.com", "d.example.com", "example.com"]);
});

test("a DMARC record is read as receivers read it: its strings joined, other TXT records ignored, tags in any case", () => {
	const cases = [
		[[["v=DMARC1; p=none;"]], "found"],
		[[["v=DMARC1; p=quarantine; ", "rua=mailto:reports@example.com"]], "found"],
		[[["google-site-verification=abc123"], ["v=DMARC1; p=reject"]], "found"],
		[[["V=DMARC1;P=Quarantine"]], "found"],
		[[[" v = DMARC1 ; p = none "]], "found"],
		[[["v=DMARC1; rua=mailto:reports@example.com"]], "found"],
		[[["v=DMARC1"]], "invalid"],
		[[["v=DMARC1; p=bogus"]], "invalid"],
		[[["v=dmarc1; p=none"]], "invalid"],
		[[["v=DMARC1; p=none;"], ["v=DMARC1; p=reject;"]], "multiple"],
		[[["v=DMARC10; p=none"]], null],
		[[["v=spf1 include:example.com ~all"]], null],
		[[["p=none; v=DMARC1"]], null],
		[[], null],
	];
	for (const [records, status] of cases) assert.equal(getDmarcStatus(records), status, JSON.stringify(records));
});

test("the DMARC row says what the last check found, and names the parent domain whose record covers it", () => {
	const domain = { domain: "news.example.com", mailFromDomain: "bounce.news.example.com", records: [] };
	const dmarc = (fields) => getDomainSetup({ ...domain, ...fields }, {}).find(({ key }) => key === "dmarc").status;
	assert.deepEqual(dmarc({}), { label: "Recommended", tone: "none" }, "never looked up");
	assert.deepEqual(dmarc({ dmarc: { status: "missing" } }), { label: "Recommended", tone: "none" });
	assert.deepEqual(dmarc({ dmarc: { status: "found", host: "news.example.com" } }), { label: "Found", tone: "good" });
	assert.deepEqual(dmarc({ dmarc: { status: "found", host: "example.com" } }), { label: "Found on example.com", tone: "good" });
	assert.deepEqual(dmarc({ dmarc: { status: "multiple", host: "example.com" } }), { label: "More than one record, keep one", tone: "bad" });
	assert.deepEqual(dmarc({ dmarc: { status: "invalid", host: "news.example.com" } }), { label: "Not valid, check the record", tone: "bad" });
});

test("TXT records come from DNS over HTTPS in their strings, escapes read; no record is none, a failed lookup null", async () => {
	const answers = {
		"_dmarc.example.com": {
			Status: 0,
			Answer: [
				{ name: "_dmarc.example.com.", type: 16, data: '"v=DMARC1; p=quarantine; " "rua=mailto:reports@example.com"' },
				{ name: "_dmarc.example.com.", type: 16, data: '"say \\"hi\\"\\059 back\\\\"' },
				{ name: "_dmarc.example.com.", type: 5, data: "elsewhere.example.net." },
			],
		},
		"_dmarc.empty.example.com": { Status: 0 },
		"_dmarc.gone.example.com": { Status: 3 },
		"_dmarc.broken.example.com": { Status: 2 },
	};
	const asked = [];
	globalThis.fetch = async (url) => {
		const { searchParams } = new URL(url);
		asked.push([searchParams.get("name"), searchParams.get("type")]);
		const answer = answers[searchParams.get("name")];
		if (!answer) throw new TypeError("fetch failed");
		return Response.json(answer);
	};

	assert.deepEqual(await readTxt("_dmarc.example.com"), [["v=DMARC1; p=quarantine; ", "rua=mailto:reports@example.com"], ['say "hi"; back\\']]);
	assert.deepEqual(asked[0], ["_dmarc.example.com", "TXT"]);
	assert.deepEqual(await readTxt("_dmarc.empty.example.com"), [], "the name, but no TXT record");
	assert.deepEqual(await readTxt("_dmarc.gone.example.com"), [], "no such name");
	assert.equal(await readTxt("_dmarc.broken.example.com"), null, "the resolver failed");
	assert.equal(await readTxt("_dmarc.unreachable.example.com"), null, "DNS over HTTPS didn't answer");
});
