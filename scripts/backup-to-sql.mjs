// Turns a downloaded backup snapshot (backups/<date>/ from the private R2 bucket) into one SQL file for an
// EMPTY D1 database created by the same migrations:
//   node scripts/backup-to-sql.mjs ./backups/2026-10-14 > restore.sql
//   npx wrangler d1 execute <database-name> --remote --file restore.sql
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKUP_TABLES, restoreStatements } from "../lib/backup.js";

export function toSqlLiteral(value) {
	if (value === null || value === undefined) return "NULL";
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
	return `'${String(value).replaceAll("'", "''")}'`;
}

export function backupToSql(directory) {
	const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
	const lines = [`-- Mailcheap backup from ${manifest.createdAt}; migrations: ${manifest.migrations.join(", ")}`, "PRAGMA defer_foreign_keys = true;"];
	for (const table of BACKUP_TABLES) {
		const file = join(directory, `${table}.ndjson`);
		if (!existsSync(file)) throw new Error(`The snapshot is missing ${table}.ndjson`);
		for (const { sql, params } of restoreStatements(table, readFileSync(file, "utf8"))) {
			let index = 0;
			lines.push(`${sql.replace(/\?/g, () => toSqlLiteral(params[index++]))};`);
		}
	}
	return `${lines.join("\n")}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	if (!process.argv[2]) throw new Error("Usage: node scripts/backup-to-sql.mjs <snapshot directory>");
	process.stdout.write(backupToSql(process.argv[2]));
}
