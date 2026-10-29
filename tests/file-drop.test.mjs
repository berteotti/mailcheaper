import assert from "node:assert/strict";
import { test } from "node:test";
import { IMAGE_TYPES } from "../lib/upload-image.js";
import { acceptsFile } from "../lib/use-file-drop.js";

test("a file is taken by its type or its extension, whatever type the system gave it", () => {
	const CSV_ACCEPT = [".csv", "text/csv"];
	assert.equal(acceptsFile({ type: "text/csv", name: "subscribers.csv" }, CSV_ACCEPT), true);
	assert.equal(acceptsFile({ type: "", name: "Subscribers.CSV" }, CSV_ACCEPT), true);
	assert.equal(acceptsFile({ type: "application/vnd.ms-excel", name: "export.csv" }, CSV_ACCEPT), true);
	assert.equal(acceptsFile({ type: "application/vnd.ms-excel", name: "budget.xls" }, CSV_ACCEPT), false);
	assert.equal(acceptsFile({ type: "image/png", name: "logo.png" }, CSV_ACCEPT), false);
	assert.equal(acceptsFile({ type: "application/pdf", name: "subscribers.csv.pdf" }, CSV_ACCEPT), false);
});

test("images are taken by type only, since uploads check the type", () => {
	assert.equal(acceptsFile({ type: "image/webp", name: "cover.webp" }, IMAGE_TYPES), true);
	assert.equal(acceptsFile({ type: "", name: "cover.png" }, IMAGE_TYPES), false);
	assert.equal(acceptsFile({ type: "image/svg+xml", name: "logo.svg" }, IMAGE_TYPES), false);
});

test("a type family and no list at all both work", () => {
	assert.equal(acceptsFile({ type: "text/plain", name: "notes.txt" }, ["text/*"]), true);
	assert.equal(acceptsFile({ type: "application/json", name: "data.json" }, ["text/*"]), false);
	assert.equal(acceptsFile({ type: "application/zip", name: "archive.zip" }, undefined), true);
});
