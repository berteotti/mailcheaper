import assert from "node:assert/strict";
import { test } from "node:test";
import { rootDomain } from "../lib/favicon.js";

test("root domains come from hosts and email addresses", () => {
	assert.equal(rootDomain("mail.example.com"), "example.com");
	assert.equal(rootDomain("news.example.org"), "example.org");
	assert.equal(rootDomain("Reader@Mail.Example.co.uk"), "example.co.uk");
	assert.equal(rootDomain("jane@example.com"), "example.com");
	assert.equal(rootDomain(""), "");
});

