import { connectDb, decodeRow, json, newId, statement } from "./db.js";

// Writes for D1 rows, the way Mongoose's $set, $unset and $inc read: a column takes a value, and a dotted path
// ("usage.emailsSent") changes one field inside a JSON column. Dates go in as milliseconds in columns and as
// ISO strings inside JSON (lib/db.js revives both).
const COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

function column(name) {
	if (!COLUMN.test(name)) throw new Error(`Not a column name: ${name}`);
	return name;
}

function isPlainObject(value) {
	return value !== null && typeof value === "object" && !(value instanceof Date) && !ArrayBuffer.isView(value);
}

// A column value: objects and arrays become JSON text.
export function columnValue(value) {
	if (Array.isArray(value) || isPlainObject(value)) return json(value);
	return value;
}

// One value inside a JSON column, bound as a parameter: objects through json(), Dates as ISO strings.
function pathValue(value) {
	if (value instanceof Date) return { sql: "?", param: value.toISOString() };
	if (Array.isArray(value) || isPlainObject(value)) return { sql: "json(?)", param: JSON.stringify(value) };
	if (typeof value === "boolean") return { sql: value ? "json('true')" : "json('false')", param: undefined };
	return { sql: "?", param: value ?? null };
}

// "a = ?, b = json_set(b, '$.c', ?)" and its parameters, for UPDATE ... SET.
export function setClause({ set = {}, unset = [], inc = {} } = {}) {
	const columns = new Map();
	const parts = [];
	const params = [];
	const jsonEdit = (name) => {
		if (!columns.has(name)) columns.set(name, { set: [], remove: [] });
		return columns.get(name);
	};
	for (const [key, value] of Object.entries(set)) {
		if (value === undefined) continue;
		if (PATH.test(key)) {
			const [name, ...path] = key.split(".");
			jsonEdit(name).set.push({ path: `$.${path.join(".")}`, ...pathValue(value) });
		} else {
			parts.push({ sql: `${column(key)} = ?`, params: [columnValue(value)] });
		}
	}
	for (const key of unset) {
		if (PATH.test(key)) {
			const [name, ...path] = key.split(".");
			jsonEdit(name).remove.push(`$.${path.join(".")}`);
		} else {
			parts.push({ sql: `${column(key)} = NULL`, params: [] });
		}
	}
	for (const [key, amount] of Object.entries(inc)) {
		if (PATH.test(key)) {
			const [name, ...path] = key.split(".");
			const at = `$.${path.join(".")}`;
			jsonEdit(name).set.push({ path: at, sql: `coalesce(json_extract(${column(name)}, '${at}'), 0) + ?`, param: amount, raw: true });
		} else {
			parts.push({ sql: `${column(key)} = coalesce(${column(key)}, 0) + ?`, params: [amount] });
		}
	}
	for (const [name, edit] of columns) {
		let expression = `coalesce(${column(name)}, '{}')`;
		const editParams = [];
		if (edit.remove.length) expression = `json_remove(${expression}, ${edit.remove.map((path) => `'${path}'`).join(", ")})`;
		if (edit.set.length) {
			// json_set creates missing parents only one level deep, so nested objects are built first.
			const parents = new Set();
			for (const { path } of edit.set) {
				const segments = path.split(".");
				for (let i = 2; i < segments.length; i++) parents.add(segments.slice(0, i).join("."));
			}
			for (const parent of parents) expression = `json_set(${expression}, '${parent}', coalesce(json_extract(${expression}, '${parent}'), json('{}')))`;
			expression = `json_set(${expression}, ${edit.set.map(({ path, sql }) => `'${path}', ${sql}`).join(", ")})`;
			for (const { param, sql } of edit.set) if (param !== undefined || sql.includes("?")) editParams.push(param);
		}
		parts.push({ sql: `${name} = ${expression}`, params: editParams });
	}
	return { sql: parts.map(({ sql }) => sql).join(", "), params: parts.flatMap(({ params }) => params) };
}

// An UPDATE statement for one table: `where` is a SQL condition with its own parameters. updatedAt is set
// unless the change names it. Add "RETURNING *" through `returning` to read the row back in the same statement.
export function updateStatement(db, table, { where, params: whereParams = [] }, change, { returning = false, touch = true } = {}) {
	const changes = { ...change, set: { ...(touch && { updatedAt: Date.now() }), ...change.set } };
	const { sql, params } = setClause(changes);
	return statement(db, `UPDATE ${column(table)} SET ${sql} WHERE ${where}${returning ? " RETURNING *" : ""}`, [...params, ...whereParams]);
}

export async function updateRows(table, where, change, options = {}) {
	return updateStatement(options.db ?? (await connectDb()), table, where, change, options).run();
}

// The changed row, or null when `where` matched nothing (for one row: `where` should name a unique key).
export async function updateOne(table, where, change, options = {}) {
	return decodeRow(await updateStatement(options.db ?? (await connectDb()), table, where, change, { ...options, returning: true }).first());
}

// An INSERT with an _id, createdAt and updatedAt unless given. Returns the row as stored.
export function insertStatement(db, table, values, { timestamps = true, orIgnore = false } = {}) {
	const now = Date.now();
	const row = { _id: newId(), ...(timestamps && { createdAt: now, updatedAt: now }), ...values };
	const names = Object.keys(row).filter((name) => row[name] !== undefined).map(column);
	return statement(
		db,
		`INSERT${orIgnore ? " OR IGNORE" : ""} INTO ${column(table)} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")}) RETURNING *`,
		names.map((name) => columnValue(row[name]))
	);
}

export async function insertRow(table, values, options = {}) {
	return decodeRow(await insertStatement(options.db ?? (await connectDb()), table, values, options).first());
}
