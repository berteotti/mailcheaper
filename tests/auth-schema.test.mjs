import assert from "node:assert/strict";
import test from "node:test";
import { getMigrations } from "better-auth/db/migration";
import { startTestApp } from "./helpers/app.mjs";
import { runWithRequest } from "./stubs/next-headers.mjs";

// migrations/0007_auth.sql must hold every table and column Better Auth's configuration needs.
test("the migrations hold Better Auth's whole schema", async (t) => {
	const app = await startTestApp();
	t.after(() => app.stop());
	const { getAuth } = await import("../lib/auth.js");
	const auth = await runWithRequest({}, () => getAuth());
	const { toBeCreated, toBeAdded } = await getMigrations(auth.options);
	assert.deepEqual(toBeCreated.map(({ table }) => table), []);
	assert.deepEqual(toBeAdded.map(({ table, fields }) => `${table}: ${Object.keys(fields)}`), []);
});
