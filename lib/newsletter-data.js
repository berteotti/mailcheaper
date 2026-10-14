import { execute, getAll, getOne, newId } from "./db.js";

export function findNewsletter(id) {
	return getOne("SELECT * FROM newsletters WHERE _id = lower(?)", [id]);
}

export function findNewsletterBySlug(slug) {
	return getOne("SELECT * FROM newsletters WHERE slug = ?", [slug]);
}

export function listNewsletters() {
	return getAll("SELECT _id, name, slug, imageUrl, fromEmail, archiveEnabled FROM newsletters ORDER BY createdAt, _id");
}

export async function saveNewsletterRecord(id, document) {
	const now = Date.now();
	const values = [document.name, document.slug, document.imageUrl, document.fromName, document.fromEmail,
		document.replyTo, document.postalAddress, Number(document.archiveEnabled), document.description,
		JSON.stringify(document.author), JSON.stringify(document.socialLinks), Number(document.requireConfirmation),
		JSON.stringify(document.cleanup), document.welcome ? JSON.stringify(document.welcome) : null,
		document.confirmation ? JSON.stringify(document.confirmation) : null];
	if (id) {
		await execute(`UPDATE newsletters SET name = ?, slug = ?, imageUrl = ?, fromName = ?, fromEmail = ?,
			replyTo = ?, postalAddress = ?, archiveEnabled = ?, description = ?, author = ?, socialLinks = ?,
			requireConfirmation = ?, cleanup = ?, welcome = coalesce(?, welcome), confirmation = coalesce(?, confirmation),
			updatedAt = ? WHERE _id = lower(?)`, [...values, now, id]);
		return id;
	}
	const createdId = newId();
	await execute(`INSERT INTO newsletters (name, slug, imageUrl, fromName, fromEmail, replyTo, postalAddress,
		archiveEnabled, description, author, socialLinks, requireConfirmation, cleanup, welcome, confirmation, _id, createdAt, updatedAt)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, coalesce(?, '{"enabled":false}'), coalesce(?, '{}'), ?, ?, ?)`,
	[...values, createdId, now, now]);
	return createdId;
}
