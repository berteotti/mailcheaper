import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { requireAccount } from "@/lib/auth";
import { getAll, getOne } from "@/lib/db";
import { NEWSLETTER_COOKIE, NEWSLETTER_SUMMARY_FIELDS, getNewsletterPagePath, getSwitchPath, pickNewsletter } from "@/lib/newsletters";
import { isObjectIdString } from "@/lib/validation";

const FIELDS = ["_id", ...NEWSLETTER_SUMMARY_FIELDS.split(" "), "fromName", "postalAddress", "archiveEnabled", "archiveHost", "createdAt"].join(", ");
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 3600;

// The newsletter the dashboard shows: the one the cookie names when it's the account's, else the account's first.
// savedId is the cookie as this request read it, so the newsletter menu can tell when a link or another tab changed it.
export const getSelectedNewsletter = cache(async () => {
	const [current, cookieStore] = await Promise.all([requireAccount(), cookies()]);
	const newsletters = await getAll(`SELECT ${FIELDS} FROM newsletters WHERE accountId = ? ORDER BY createdAt, _id`, [current.account._id]);
	const savedId = cookieStore.get(NEWSLETTER_COOKIE)?.value ?? null;
	return { ...current, newsletters, savedId, selected: pickNewsletter(newsletters, savedId) };
});

// A page showing another of the account's newsletters than the open one (a campaign's, or ?newsletter= in an old
// link) goes through /newsletters/<id>, which opens it: the menu and the page then show the same newsletter.
// An ID that isn't one of the account's newsletters changes nothing.
export function openNewsletter({ newsletters, selected }, id, path) {
	const value = id ? String(id) : null;
	if (!value || value === String(selected?._id) || !newsletters.some(({ _id }) => String(_id) === value)) return;
	redirect(getNewsletterPagePath(value, path));
}

// Pages can't set cookies: server actions and route handlers call this. Null when the signed-in account has no
// such newsletter.
export async function saveSelectedNewsletter(id) {
	const value = String(id ?? "");
	if (!isObjectIdString(value)) return null;
	const { account } = await requireAccount();
	const newsletter = await getOne("SELECT _id FROM newsletters WHERE accountId = ? AND _id = ?", [account._id, value]);
	if (!newsletter) return null;
	(await cookies()).set(NEWSLETTER_COOKIE, value, { maxAge: COOKIE_MAX_AGE_SECONDS, sameSite: "lax" });
	return newsletter;
}

// The newsletter menu: on one of a newsletter's pages, the same page of the other one opens; the account's own
// pages stay where they are.
export async function switchNewsletter(id, pathname) {
	if (!(await saveSelectedNewsletter(id))) return { error: "Newsletter not found" };
	const path = getSwitchPath(String(pathname ?? ""));
	if (path) redirect(path);
	return { ok: true };
}
