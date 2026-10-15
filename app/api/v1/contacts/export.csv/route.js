import { ERROR_CODES, hasActiveSubscription } from "@/lib/account-state";
import { contactSearchFilter } from "@/lib/contacts";
import { getCsvHeader, toCsvRow } from "@/lib/contacts-csv";
import { getAll, getOne } from "@/lib/db";
import { verifyExportToken } from "@/lib/export-token";

const ROWS_PER_CHUNK = 500;

function fail(status, code, message) {
	return Response.json({ error: { code, message } }, { status });
}

// The file behind an export_contacts link: the signed token names the account and the filters.
export async function GET(request) {
	const link = verifyExportToken(new URL(request.url).searchParams.get("token"));
	if (!link) return fail(401, "unauthorized", "This download link is invalid or expired: export again");

	const account = await getOne("SELECT * FROM accounts WHERE _id = ?", [link.accountId]);
	if (!hasActiveSubscription(account)) return fail(402, ERROR_CODES.subscriptionRequired, "The account has no active plan");
	const newsletters = new Map(
		(await getAll("SELECT _id, slug FROM newsletters WHERE accountId = ?", [account._id])).map(({ _id, slug }) => [_id, slug])
	);
	const filter = contactSearchFilter(account, { newsletterId: link.newsletterId, query: link.query });
	if (link.status) {
		filter.where += " AND status = ?";
		filter.params.push(link.status);
	}
	const encoder = new TextEncoder();
	let isStarted = false;
	let last = null;

	// One bounded page per pull, continuing after the previous page's last contact.
	const stream = new ReadableStream({
		async pull(controller) {
			let chunk = isStarted ? "" : getCsvHeader();
			isStarted = true;
			const after = last ? " AND (subscribedAt < ? OR (subscribedAt = ? AND _id < ?))" : "";
			const contacts = await getAll(
				`SELECT * FROM contacts WHERE ${filter.where}${after} ORDER BY subscribedAt DESC, _id DESC LIMIT ?`,
				[...filter.params, ...(last ? [last.subscribedAt, last.subscribedAt, last._id] : []), ROWS_PER_CHUNK]
			);
			for (const contact of contacts) chunk += toCsvRow(contact, newsletters);
			if (chunk) controller.enqueue(encoder.encode(chunk));
			if (contacts.length < ROWS_PER_CHUNK) controller.close();
			else last = contacts.at(-1);
		},
	});
	const date = new Date().toISOString().slice(0, 10);
	return new Response(stream, {
		headers: {
			"content-type": "text/csv; charset=utf-8",
			"content-disposition": `attachment; filename="contacts-${date}.csv"`,
			"cache-control": "no-store",
		},
	});
}
