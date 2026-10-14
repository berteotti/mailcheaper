import { redirect } from "next/navigation";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";

// Add a newsletter was a page here: old links open its dialog on the dashboard.
export function GET() {
	redirect(ADD_NEWSLETTER_PATH);
}
