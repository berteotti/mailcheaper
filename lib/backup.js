import { connectDb, getAll, getBindings } from "./db.js";

// Every table worth restoring, parents first so a restore can insert them in this order, with the key each is
// paged by. Sign-in codes (verifications) and OAuth client assertions expire within minutes and are left out.
const TABLE_KEYS = {
	users: "id",
	organizations: "_id",
	members: "_id",
	invitations: "_id",
	accounts: "_id",
	account_secrets: "accountId",
	newsletters: "_id",
	contact_imports: "_id",
	contacts: "_id",
	campaigns: "_id",
	campaign_editions: "_id",
	messages: "_id",
	events: "_id",
	suppressions: "_id",
	api_keys: "_id",
	alerts: "_id",
	domains: "_id",
	uploads: "_id",
	deletion_records: "_id",
	sessions: "id",
	auth_accounts: "id",
	jwks: "id",
	oauthClient: "id",
	oauthResource: "id",
	oauthClientResource: "id",
	oauthRefreshToken: "id",
	oauthAccessToken: "id",
	oauthConsent: "id",
};
export const BACKUP_TABLES = Object.keys(TABLE_KEYS);
const PAGE_SIZE = 1000;
// R2 multipart parts must be at least 5 MB, except the last one.
const PART_BYTES = 8 * 1024 * 1024;

// Raw rows, as D1 stores them: restoring needs no knowledge of the app's decoding.
async function* tableRows(table) {
	const key = TABLE_KEYS[table];
	let after = "";
	for (;;) {
		const db = await connectDb();
		const { results } = await db.prepare(`SELECT * FROM "${table}" WHERE "${key}" > ? ORDER BY "${key}" LIMIT ?`).bind(after, PAGE_SIZE).all();
		for (const row of results) yield row;
		if (results.length < PAGE_SIZE) return;
		after = results.at(-1)[key];
	}
}

async function writeTable(bucket, key, table) {
	const upload = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: "application/x-ndjson" } });
	const parts = [];
	let pending = "";
	let rows = 0;
	try {
		for await (const row of tableRows(table)) {
			pending += `${JSON.stringify(row)}\n`;
			rows++;
			if (pending.length >= PART_BYTES) {
				parts.push(await upload.uploadPart(parts.length + 1, pending));
				pending = "";
			}
		}
		parts.push(await upload.uploadPart(parts.length + 1, pending));
		await upload.complete(parts);
		return rows;
	} catch (error) {
		await upload.abort().catch(() => {});
		throw error;
	}
}

// One private, dated snapshot per day: backups/<date>/<table>.ndjson, plus a manifest written last, so a
// snapshot without its manifest is incomplete. D1 Time Travel remains the first recovery option.
export async function backupDatabase(now = new Date()) {
	const { BACKUPS_BUCKET } = await getBindings();
	if (!BACKUPS_BUCKET) return { skipped: "no backup bucket" };
	const prefix = `backups/${now.toISOString().slice(0, 10)}`;
	const counts = {};
	for (const table of BACKUP_TABLES) counts[table] = await writeTable(BACKUPS_BUCKET, `${prefix}/${table}.ndjson`, table);
	const migrations = await getAll("SELECT * FROM __alchemy_migrations").catch(() => []);
	await BACKUPS_BUCKET.put(`${prefix}/manifest.json`, JSON.stringify({
		createdAt: now.toISOString(), tables: counts, migrations: migrations.map((row) => row.name ?? row.id ?? JSON.stringify(row)),
	}, null, 2), { httpMetadata: { contentType: "application/json" } });
	return { prefix, counts };
}

// INSERT statements for one table's NDJSON, for a database created from the same migrations. Rows go in
// with the triggers' counters already included, so callers must restore into an empty database.
export function restoreStatements(table, ndjson) {
	if (!BACKUP_TABLES.includes(table)) throw new Error(`Unknown table ${table}`);
	return ndjson.split("\n").filter(Boolean).map((line) => {
		const row = JSON.parse(line);
		const columns = Object.keys(row);
		return { sql: `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`, params: Object.values(row) };
	});
}
