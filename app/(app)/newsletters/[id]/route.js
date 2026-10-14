import { notFound, redirect } from "next/navigation";
import { saveSelectedNewsletter } from "@/lib/selected-newsletter";
import { toSafeNextPath } from "@/lib/validation";

// Opens one of the account's newsletters: its settings, or the page in ?next=. A campaign of another newsletter
// comes through here first, so the menu and the page show the same newsletter.
export async function GET(request, { params }) {
	const { id } = await params;
	if (!(await saveSelectedNewsletter(id))) notFound();
	const next = new URL(request.url).searchParams.get("next");
	redirect(next ? toSafeNextPath(next) : "/newsletters");
}
