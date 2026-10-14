import Link from "next/link";
import { ArrowUpRight, Users } from "lucide-react";
import BlockCode from "@/components/BlockCode";
import DialogAddContact from "@/components/DialogAddContact";
import DialogImportContacts from "@/components/DialogImportContacts";
import GatePlan from "@/components/GatePlan";
import IconBrand from "@/components/IconBrand";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// The contacts page of a newsletter without contacts: the two ways in, side by side, and adding one by hand to try it.
export default function CardAddContacts({ newsletter, curl }) {
	return (
		<section
			aria-labelledby="add-contacts-title"
			style={{ "--stagger": 1 }}
			className="@container overflow-hidden rounded-2xl bg-card shadow-border animate-enter"
		>
			<header className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
				<span className="grid size-9 shrink-0 place-items-center rounded-xl bg-muted text-muted-foreground">
					<Users className="size-4" />
				</span>
				<div className="min-w-0">
					<h2 id="add-contacts-title" className="font-semibold tracking-tight">
						No contacts yet
					</h2>
					<p className="text-sm text-muted-foreground">Add them in one of two ways.</p>
				</div>
			</header>
			{/* The request's lines are the longest: side by side, it gets the wider column. */}
			<div className="grid @4xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
				<ColumnWay
					title="Import your list"
					description="Bring your subscribers from beehiiv, Substack, Mailchimp, Kit or a CSV file."
				>
					<ul
						aria-hidden="true"
						className="flex flex-wrap content-center justify-center gap-x-2 gap-y-4 rounded-xl bg-card px-3 py-6 shadow-border"
					>
						{SOURCES.map(({ id, name }) => (
							<li key={id} className="flex w-16 flex-col items-center gap-2">
								<IconBrand brand={id} className="size-10" />
								<span className="text-xs text-muted-foreground">{name}</span>
							</li>
						))}
					</ul>
					<div className="flex items-center">
						<GatePlan reason="import">
							<DialogImportContacts newsletter={newsletter} label="Import contacts" variant="default" />
						</GatePlan>
					</div>
				</ColumnWay>
				<ColumnWay
					title="Add them with the API"
					description="Sign people up from your site or app, one request each."
					className="border-t border-border/60 @4xl:border-t-0 @4xl:border-l"
				>
					<BlockCode code={curl} title="Request" />
					<div className="flex flex-wrap items-center gap-x-4 gap-y-2">
						<Button asChild variant="outline">
							<Link href="/api-keys">Create an API key</Link>
						</Button>
						<Link
							href="/docs/api#add-contact"
							target="_blank"
							className="relative inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors duration-150 after:absolute after:-inset-x-2 after:-inset-y-2 hover:text-foreground"
						>
							API docs
							<ArrowUpRight className="size-3.5" />
						</Link>
					</div>
				</ColumnWay>
			</div>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border/60 bg-muted/40 px-5 py-3">
				<p className="text-sm text-muted-foreground">Trying it out? Add yourself as a contact.</p>
				<DialogAddContact newsletter={newsletter} variant="outline" size="sm" />
			</div>
		</section>
	);
}

function ColumnWay({ title, description, className, children }) {
	return (
		<div className={cn("flex min-w-0 flex-col gap-4 p-5 @4xl:row-span-3 @4xl:grid @4xl:grid-rows-subgrid", className)}>
			<div>
				<h3 className="text-sm font-semibold">{title}</h3>
				<p className="mt-1 text-sm text-muted-foreground">{description}</p>
			</div>
			{children}
		</div>
	);
}

const SOURCES = [
	{ id: "beehiiv", name: "beehiiv" },
	{ id: "substack", name: "Substack" },
	{ id: "mailchimp", name: "Mailchimp" },
	{ id: "kit", name: "Kit" },
];
