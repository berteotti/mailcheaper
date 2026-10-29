import { redirect } from "next/navigation";
import FormTheme from "@/components/FormTheme";
import HeaderPage from "@/components/HeaderPage";
import { getOne } from "@/lib/db";
import { ADD_NEWSLETTER_PATH } from "@/lib/newsletters";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { serialize } from "@/lib/serialize";
import { THEME_FONTS, getFontFaceCss } from "@/lib/theme-fonts";

export const metadata = { title: "Design" };

// Every preset's fonts load here for the previews; the dashboard has Geist already.
const FONT_FACES = getFontFaceCss(THEME_FONTS.filter((font) => font.id !== "geist"));

export default async function DesignPage() {
	const { account, selected } = await getSelectedNewsletter();
	if (!selected) redirect(ADD_NEWSLETTER_PATH);
	const newsletter = await getOne(
		"SELECT _id, name, slug, imageUrl, description, fromName, fromEmail, postalAddress, theme FROM newsletters WHERE accountId = ? AND _id = ?",
		[account._id, selected._id]
	);

	return (
		<div className="mx-auto w-full max-w-5xl">
			<style dangerouslySetInnerHTML={{ __html: FONT_FACES }} />
			<HeaderPage title="Design" backHref="/newsletters" />
			<FormTheme key={String(newsletter._id)} newsletter={serialize(newsletter)} postalAddress={newsletter.postalAddress} />
		</div>
	);
}
