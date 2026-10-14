// Prints the SQL for Better Auth's tables, as lib/auth.js configures it, that a database with the app's
// migrations still lacks: node --import ./tests/setup/register.mjs scripts/print-auth-schema.mjs
import { getMigrations } from "better-auth/db/migration";
import { createDatabase } from "../tests/helpers/d1.mjs";
import { runWithRequest } from "../tests/stubs/next-headers.mjs";

Object.assign(process.env, {
	BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET || "schema-only-secret-0123456789abcdef0123456789",
	APP_URL: process.env.APP_URL || "http://localhost:3000",
	MAILCHEAP_CLOUD: "true",
});
createDatabase();
const { getAuth } = await import("../lib/auth.js");
const auth = await runWithRequest({}, () => getAuth());
const { compileMigrations } = await getMigrations(auth.options);
console.log(await compileMigrations());
