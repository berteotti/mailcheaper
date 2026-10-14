import crypto from "node:crypto";
import { Suspense } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Users } from "lucide-react";
import AvatarContact from "@/components/AvatarContact";
import BadgeStatus from "@/components/BadgeStatus";
import ButtonExportContacts from "@/components/ButtonExportContacts";
import CardAddContacts from "@/components/CardAddContacts";
import DialogAddContact from "@/components/DialogAddContact";
import DialogImportContacts from "@/components/DialogImportContacts";
import FilterContacts from "@/components/FilterContacts";
import GatePlan from "@/components/GatePlan";
import HeaderPage from "@/components/HeaderPage";
import MenuContact from "@/components/MenuContact";
import StateEmpty from "@/components/StateEmpty";
import TextEmpty from "@/components/TextEmpty";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { getAppUrl } from "@/lib/config";
import { CONTACTS_PAGE_SIZE, findContactsPage } from "@/lib/contacts";
import { getValue } from "@/lib/db";
import { getAddContactCurl } from "@/lib/docs/reference";
import { formatDate, formatNumber } from "@/lib/format";
import { toNewsletterOption } from "@/lib/newsletters";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";
import { CONTACT_STATUSES } from "@/lib/statuses";
import { cn } from "@/lib/utils";

export const metadata = { title: "Contacts" };

// The open newsletter's contacts. A newsletter in ?newsletter=, from the filter this page had, opens first.
export default async function ContactsPage({ searchParams }) {
	const [view, params] = await Promise.all([getSelectedNewsletter(), searchParams]);
	openNewsletter(view, params.newsletter, "/contacts");
	const { account, selected } = view;
	const newsletterId = selected ? String(selected._id) : null;
	const status = CONTACT_STATUSES.includes(params.status) ? params.status : null;
	const query = typeof params.q === "string" ? params.q.trim().toLowerCase().slice(0, 254) : "";
	const page = Math.max(1, Number.parseInt(params.page, 10) || 1);

	const { contacts, counts, totalAll, total } = newsletterId
		? await findContactsPage(account, { newsletterId, status, query, page })
		: { contacts: [], counts: {}, totalAll: 0, total: 0 };
	const pageCount = Math.max(1, Math.ceil(total / CONTACTS_PAGE_SIZE));
	// totalAll counts within the search.
	const hasContacts =
		totalAll > 0 ||
		Boolean(
			query &&
				newsletterId &&
				(await getValue("SELECT 1 FROM contacts WHERE accountId = ? AND newsletterId = ? LIMIT 1", [String(account._id), newsletterId]))
		);
	const newsletter = selected && toNewsletterOption(selected);

	function href(changes) {
		const next = new URLSearchParams(Object.entries({ status, q: query, page }).filter(([, value]) => value));
		for (const [key, value] of Object.entries(changes)) {
			if (value) next.set(key, value);
			else next.delete(key);
		}
		if (next.get("page") === "1") next.delete("page");
		return `/contacts${next.size ? `?${next}` : ""}`;
	}

	return (
		<>
			<HeaderPage title="Contacts">
				<ButtonExportContacts newsletterId={newsletterId} status={status} query={query} isDisabled={total === 0} />
				{hasContacts && <DialogAddContact newsletter={newsletter} />}
				<GatePlan reason="import">
					<DialogImportContacts newsletter={newsletter} />
				</GatePlan>
			</HeaderPage>

			<div className="flex flex-col gap-4">
				{hasContacts && (
					<>
						<Suspense fallback={<Skeleton className="h-9 w-full rounded-lg" />}>
							<FilterContacts key={newsletterId} />
						</Suspense>

						<nav
							aria-label="Status"
							className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 animate-enter [scrollbar-width:none]"
						>
							{[null, ...CONTACT_STATUSES].map((key) => {
								const isActive = key === status;
								return (
									<Link
										key={key ?? "all"}
										href={href({ status: key, page: null })}
										scroll={false}
										aria-current={isActive ? "page" : undefined}
										className={cn(
											"inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm transition-[color,background-color,box-shadow] duration-150",
											isActive
												? "bg-foreground text-background"
												: "text-muted-foreground hover:bg-muted hover:text-foreground"
										)}
									>
										{key ? key.charAt(0).toUpperCase() + key.slice(1) : "All"}
										<span className={cn("text-xs tabular-nums", isActive ? "opacity-70" : "opacity-60")}>
											{formatNumber(key ? counts[key] || 0 : totalAll)}
										</span>
									</Link>
								);
							})}
						</nav>
					</>
				)}

				{!hasContacts ? (
					<CardAddContacts newsletter={newsletter} curl={getAddContactCurl(getAppUrl(), selected?.slug)} />
				) : contacts.length === 0 ? (
					<StateEmpty icon={Users} title="No contacts match" />
				) : (
					<div style={{ "--stagger": 1 }} className="overflow-hidden rounded-xl shadow-border animate-enter">
						<Table>
							<TableHeader>
								<TableRow className="hover:bg-transparent">
									<TableHead className="pl-4">Email</TableHead>
									<TableHead>Status</TableHead>
									<TableHead className="hidden text-right lg:table-cell">Opens</TableHead>
									<TableHead className="hidden text-right lg:table-cell">Clicks</TableHead>
									<TableHead className="hidden text-right sm:table-cell">Added</TableHead>
									<TableHead className="w-12 pr-2" />
								</TableRow>
							</TableHeader>
							<TableBody>
								{contacts.map((contact) => (
									<TableRow key={contact._id.toString()} className="tabular-nums">
										<TableCell className="w-full max-w-0 py-2.5 pl-4 font-medium sm:w-2/5">
											<span className="flex min-w-0 items-center gap-2.5">
												<AvatarContact
													email={contact.email}
													colorHash={contactColorHash(contact.email)}
													size={26}
												/>
												<span className="truncate">{contact.email}</span>
											</span>
										</TableCell>
										<TableCell>
											<BadgeStatus status={contact.status} />
										</TableCell>
										<TableCell className="hidden text-right lg:table-cell">
											{engagement(contact, "opens", "openRate")}
										</TableCell>
										<TableCell className="hidden text-right lg:table-cell">
											{engagement(contact, "clicks", "clickRate")}
										</TableCell>
										<TableCell className="hidden text-right text-muted-foreground sm:table-cell">
											{formatDate(contact.subscribedAt) ?? <TextEmpty />}
										</TableCell>
										<TableCell className="pr-2 text-right">
											<MenuContact id={contact._id.toString()} status={contact.status} />
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</div>
				)}

				{pageCount > 1 && (
					<div className="flex items-center justify-between gap-3 text-sm text-muted-foreground tabular-nums">
						<span>
							{formatNumber((page - 1) * CONTACTS_PAGE_SIZE + 1)}–
							{formatNumber(Math.min(page * CONTACTS_PAGE_SIZE, total))} of{" "}
							{formatNumber(total)}
						</span>
						<div className="flex gap-1">
							<PageLink href={href({ page: page - 1 })} isDisabled={page <= 1} label="Previous">
								<ChevronLeft />
							</PageLink>
							<PageLink href={href({ page: page + 1 })} isDisabled={page >= pageCount} label="Next">
								<ChevronRight />
							</PageLink>
						</div>
					</div>
				)}
			</div>
		</>
	);
}

function PageLink({ href, isDisabled, label, children }) {
	if (isDisabled) {
		return (
			<Button variant="outline" size="icon" disabled aria-label={label}>
				{children}
			</Button>
		);
	}
	return (
		<Button asChild variant="outline" size="icon">
			<Link href={href} scroll={false} aria-label={label}>
				{children}
			</Link>
		</Button>
	);
}

function contactColorHash(email) {
	return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function engagement(contact, statKey, importedKey) {
	if (contact.stats?.[statKey]) return formatNumber(contact.stats[statKey]);
	const rate = contact.imported?.[importedKey];
	return rate === undefined || rate === null ? <TextEmpty /> : `${Math.round(rate * 100)}%`;
}
