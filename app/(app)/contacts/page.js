import crypto from "node:crypto";
import { Suspense } from "react";
import Link from "next/link";
import { ChevronLeft, ChevronRight, Users } from "lucide-react";
import AvatarContact from "@/components/AvatarContact";
import BadgeStatus from "@/components/BadgeStatus";
import BarContactSelection from "@/components/BarContactSelection";
import ButtonExportContacts from "@/components/ButtonExportContacts";
import CardAddContacts from "@/components/CardAddContacts";
import CheckboxContact from "@/components/CheckboxContact";
import DialogAddContact from "@/components/DialogAddContact";
import DialogCheckContacts from "@/components/DialogCheckContacts";
import DialogEditContacts from "@/components/DialogEditContacts";
import DialogImportContacts from "@/components/DialogImportContacts";
import FilterContacts from "@/components/FilterContacts";
import GatePlan from "@/components/GatePlan";
import HeaderPage from "@/components/HeaderPage";
import MenuContact from "@/components/MenuContact";
import ProviderContactSelection from "@/components/ProviderContactSelection";
import StateEmpty from "@/components/StateEmpty";
import TableHeadSort from "@/components/TableHeadSort";
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
import {
	CONTACTS_PAGE_SIZE,
	CONTACT_SORTS,
	DEFAULT_CONTACT_SORT,
	LIVE_STATUSES,
	contactSearchFilter,
	countContactsByLanguage,
	countContactsByStatus,
	findContactsPage,
} from "@/lib/contacts";
import { getAddContactCurl } from "@/lib/docs/reference";
import { formatDate, formatNumber, formatRelative } from "@/lib/format";
import { getLanguageName, getLanguageTag, normalizeLanguage } from "@/lib/languages";
import { toNewsletterOption } from "@/lib/newsletters";
import { getSelectedNewsletter, openNewsletter } from "@/lib/selected-newsletter";
import { CONTACT_STATUSES } from "@/lib/statuses";
import { cn } from "@/lib/utils";

export const metadata = { title: "Contacts" };

// The open newsletter's contacts. A newsletter in ?newsletter=, from the filter this page had, opens first. Its language
// filter finds that tag alone (pt leaves out pt-BR), as the menu counts them.
export default async function ContactsPage({ searchParams }) {
	const [view, params] = await Promise.all([getSelectedNewsletter(), searchParams]);
	openNewsletter(view, params.newsletter, "/contacts");
	const { account, selected } = view;
	const newsletterId = selected ? String(selected._id) : null;
	const status = CONTACT_STATUSES.includes(params.status) ? params.status : null;
	const query = typeof params.q === "string" ? params.q.trim().toLowerCase().slice(0, 254) : "";
	const language = normalizeLanguage(params.language);
	const sort = Object.hasOwn(CONTACT_SORTS, params.sort) ? params.sort : null;
	const order = ["asc", "desc"].includes(params.order) ? params.order : null;
	const page = Math.max(1, Number.parseInt(params.page, 10) || 1);

	const [{ contacts, counts, totalAll, total }, languages] = newsletterId
		? await Promise.all([
				findContactsPage(account, { newsletterId, status, query, language, exactLanguage: true, sort, order, page }),
				countContactsByLanguage(account, newsletterId),
			])
		: [{ contacts: [], counts: {}, totalAll: 0, total: 0 }, []];
	const pageCount = Math.max(1, Math.ceil(total / CONTACTS_PAGE_SIZE));
	const hasContacts = languages.length > 0;
	const newsletter = selected && toNewsletterOption(selected);
	// The address check looks at the whole newsletter, whatever the search.
	const allCounts =
		(query || language) && hasContacts ? await countContactsByStatus(contactSearchFilter(account, { newsletterId })) : counts;
	const liveCount = LIVE_STATUSES.reduce((sum, key) => sum + (allCounts[key] || 0), 0);
	const sortedBy = sort ?? DEFAULT_CONTACT_SORT;
	const sortedOrder = order ?? CONTACT_SORTS[sortedBy].order;

	function href(changes) {
		const next = new URLSearchParams(Object.entries({ status, q: query, language, sort, order, page }).filter(([, value]) => value));
		for (const [key, value] of Object.entries(changes)) {
			if (value) next.set(key, value);
			else next.delete(key);
		}
		if (next.get("page") === "1") next.delete("page");
		return `/contacts${next.size ? `?${next}` : ""}`;
	}

	// A column first sorts the list in its own order, then the other way; the URL leaves out what's the default.
	function sortHead(key, label, { className, align } = {}) {
		const isSorted = key === sortedBy;
		const next = isSorted ? (sortedOrder === "asc" ? "desc" : "asc") : CONTACT_SORTS[key].order;
		const link = href({
			sort: key === DEFAULT_CONTACT_SORT ? null : key,
			order: next === CONTACT_SORTS[key].order ? null : next,
			page: null,
		});
		return (
			<TableHeadSort href={link} order={isSorted ? sortedOrder : null} align={align} className={className}>
				{label}
			</TableHeadSort>
		);
	}

	return (
		<>
			<HeaderPage title="Contacts">
				<ButtonExportContacts newsletterId={newsletterId} status={status} query={query} language={language} isDisabled={total === 0} />
				{liveCount > 0 && <DialogCheckContacts newsletter={newsletter} count={liveCount} />}
				{hasContacts && <DialogEditContacts newsletter={newsletter} newsletterLanguage={getLanguageTag(selected)} />}
				{hasContacts && <DialogAddContact newsletter={newsletter} />}
				<GatePlan reason="import">
					<DialogImportContacts newsletter={newsletter} />
				</GatePlan>
			</HeaderPage>

			<div className="flex flex-col gap-4">
				{hasContacts && (
					<>
						<Suspense fallback={<Skeleton className="h-9 w-full rounded-lg" />}>
							<FilterContacts key={newsletterId} languages={languages} />
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

				<ProviderContactSelection key={`${newsletterId}:${status}:${query}:${language}`}>
					{!hasContacts ? (
						<CardAddContacts newsletter={newsletter} curl={getAddContactCurl(getAppUrl(), selected?.slug)} />
					) : contacts.length === 0 ? (
						<StateEmpty icon={Users} title="No contacts match" />
					) : (
						<div style={{ "--stagger": 1 }} className="overflow-hidden rounded-xl shadow-border animate-enter">
							<Table>
								<TableHeader>
									<TableRow className="hover:bg-transparent">
										<TableHead className="w-10 pr-0 pl-4">
											<CheckboxContact
												ids={contacts.map((contact) => contact._id.toString())}
												label="Select every contact on this page"
											/>
										</TableHead>
										{sortHead("name", "Contact")}
										{sortHead("status", "Status")}
										{sortHead("language", "Language", { className: "hidden md:table-cell" })}
										{sortHead("opens", "Opens", { className: "hidden text-right lg:table-cell", align: "end" })}
										{sortHead("clicks", "Clicks", { className: "hidden text-right lg:table-cell", align: "end" })}
										{sortHead("subscribedAt", "Added", { className: "hidden text-right sm:table-cell", align: "end" })}
										{sortHead("updatedAt", "Updated", { className: "hidden text-right sm:table-cell", align: "end" })}
										<TableHead className="w-12 pr-2" />
									</TableRow>
								</TableHeader>
								<TableBody>
									{contacts.map((contact) => (
										<TableRow key={contact._id.toString()} className="tabular-nums">
											<TableCell className="w-10 pr-0 pl-4">
												<CheckboxContact id={contact._id.toString()} label={`Select ${contact.email}`} />
											</TableCell>
											<TableCell className="w-full max-w-0 py-2.5 font-medium sm:w-2/5">
												<span className="flex min-w-0 items-center gap-2.5">
													<AvatarContact
														email={contact.email}
														name={contact.firstName ?? contact.lastName}
														colorHash={contactColorHash(contact.email)}
														size={26}
													/>
													{getName(contact) ? (
														<span className="flex min-w-0 flex-col">
															<span className="truncate">{getName(contact)}</span>
															<span className="truncate text-xs font-normal text-muted-foreground">
																{contact.email}
															</span>
														</span>
													) : (
														<span className="truncate">{contact.email}</span>
													)}
												</span>
											</TableCell>
											<TableCell>
												<BadgeStatus status={contact.status} />
											</TableCell>
											<TableCell className="hidden md:table-cell">
												{contact.language ? (
													getLanguageName(getLanguageTag(contact))
												) : (
													<span className="text-muted-foreground" title="The newsletter's language">
														{getLanguageName(getLanguageTag(selected))}
													</span>
												)}
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
											<TableCell className="hidden text-right text-muted-foreground sm:table-cell" title={formatDate(contact.updatedAt)}>
												{formatRelative(contact.updatedAt)}
											</TableCell>
											<TableCell className="pr-2 text-right">
												<MenuContact
													id={contact._id.toString()}
													email={contact.email}
													firstName={contact.firstName}
													lastName={contact.lastName}
													status={contact.status}
													language={getLanguageTag(contact)}
													newsletterLanguage={getLanguageTag(selected)}
												/>
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
					<BarContactSelection newsletterLanguage={getLanguageTag(selected)} />
				</ProviderContactSelection>
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

function getName({ firstName, lastName }) {
	return [firstName, lastName].filter(Boolean).join(" ");
}

function contactColorHash(email) {
	return crypto.createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function engagement(contact, statKey, importedKey) {
	if (contact.stats?.[statKey]) return formatNumber(contact.stats[statKey]);
	const rate = contact.imported?.[importedKey];
	return rate === undefined || rate === null ? <TextEmpty /> : `${Math.round(rate * 100)}%`;
}
