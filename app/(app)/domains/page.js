import Image from "next/image";
import { ArrowUpRight, Check, Mail } from "lucide-react";
import ButtonCheckDomain from "@/components/ButtonCheckDomain";
import ButtonCopy from "@/components/ButtonCopy";
import DialogRemoveDomain from "@/components/DialogRemoveDomain";
import FormAddDomain from "@/components/FormAddDomain";
import FormSwitchToDomain from "@/components/FormSwitchToDomain";
import GatePlan from "@/components/GatePlan";
import HeaderPage from "@/components/HeaderPage";
import ImageFavicon from "@/components/ImageFavicon";
import { hasActiveSubscription } from "@/lib/account-state";
import { getArchiveCnameTarget, getSharedDomain } from "@/lib/config";
import { getAll } from "@/lib/db";
import { getDomainSetup, getDomainSummary } from "@/lib/domain-records";
import { getEmailProvider } from "@/lib/email-provider";
import { rootDomain } from "@/lib/favicon";
import {
	getEmailDomain,
	getOwnDomainLocalPart,
	getSharedAddress,
	isOnSharedDomain,
	isSharedSenderReady,
	withActiveProvider,
} from "@/lib/sender-rules";
import { getSelectedNewsletter } from "@/lib/selected-newsletter";
import { refreshSharedSender } from "@/lib/shared-sender";
import { cn } from "@/lib/utils";

export const metadata = { title: "Domains" };

// The account's domains, which any of its newsletters can send from. Statuses are as of the last check: "Check now"
// asks the email provider and DNS again.
export default async function DomainsPage() {
	const { account, selected } = await getSelectedNewsletter();
	const [stored, saved] = await Promise.all([
		getAll("SELECT * FROM domains WHERE accountId = ? ORDER BY createdAt, _id", [account._id]),
		getAll("SELECT _id, name, slug, fromEmail, sharedSender FROM newsletters WHERE accountId = ? ORDER BY createdAt, _id", [account._id]),
	]);
	const domains = stored.map((domain) => withActiveProvider(domain));
	const sharedDomain = getSharedDomain();
	const hasPlan = hasActiveSubscription(account);
	// A shared address still being set up is looked at again, at most once a minute. Without a plan there's none yet.
	const newsletters = await Promise.all(
		saved.map((newsletter) =>
			!hasPlan || isSharedSenderReady(newsletter, { sharedDomain }) ? newsletter : refreshSharedSender(account, newsletter)
		)
	);
	const cnameTarget = getArchiveCnameTarget();
	const isProviderSetUp = getEmailProvider().isConfigured();
	const hasVerifiedDomain = domains.some(({ verified }) => verified);
	const sharedNewsletters = sharedDomain ? newsletters : [];
	const current = newsletters.find(({ _id }) => String(_id) === String(selected?._id)) ?? null;

	return (
		<>
			<HeaderPage title="Domains" />
			<div className="flex flex-col gap-6">
				<GatePlan reason="domain">
					<FormAddDomain fromLocalPart={getOwnDomainLocalPart(current?.fromEmail, sharedDomain)} />
				</GatePlan>
				{domains.map((domain, index) => (
					<CardDomain
						key={String(domain._id)}
						domain={domain}
						newsletters={hasPlan ? newsletters : []}
						current={hasPlan ? current : null}
						sharedDomain={sharedDomain}
						cnameTarget={cnameTarget}
						stagger={index + 1}
					/>
				))}
				{(hasVerifiedDomain || sharedNewsletters.length > 0) && (
					<div className="-mt-2 flex flex-col">
						{hasVerifiedDomain && (
							<RowNote
								href="https://postmaster.google.com/v2/"
								icon={<Image src="/logos/postmaster-tools.webp" alt="" width={20} height={20} loading="lazy" unoptimized />}
								label="Postmaster Tools"
								detail="See how Gmail rates your domain"
								end={<ArrowUpRight className="size-4 shrink-0 text-muted-foreground" />}
								stagger={domains.length + 1}
							/>
						)}
						{sharedNewsletters.map((newsletter, index) => (
							<RowNote
								key={String(newsletter._id)}
								icon={<Mail className="size-4 text-muted-foreground" />}
								label="Shared address"
								detail={<span className="font-mono text-xs">{getSharedAddress(newsletter.slug, sharedDomain)}</span>}
								end={<TextStatus {...getSharedStatus(newsletter, { sharedDomain, isProviderSetUp, hasPlan })} className="shrink-0 text-xs" />}
								stagger={domains.length + 2 + index}
							/>
						))}
					</div>
				)}
			</div>
		</>
	);
}

function getSharedStatus(newsletter, { sharedDomain, isProviderSetUp, hasPlan }) {
	if (!isOnSharedDomain(newsletter.fromEmail, sharedDomain)) return { label: "Not in use", tone: "none" };
	if (!isProviderSetUp) return { label: "Email provider not set up", tone: "none" };
	if (!hasPlan) return { label: "Starts with a plan", tone: "none" };
	return isSharedSenderReady(newsletter, { sharedDomain }) ? { label: "Used until you switch", tone: "good" } : { label: "Setting up", tone: "wait" };
}

function RowNote({ href, icon, label, detail, end, stagger }) {
	const Row = href ? "a" : "div";
	return (
		<Row
			{...(href && { href, target: "_blank", rel: "noreferrer" })}
			style={{ "--stagger": stagger }}
			className={cn(
				"flex min-h-11 items-center gap-3 rounded-xl px-4 py-2.5 text-sm animate-enter",
				href && "transition-colors duration-150 hover:bg-muted/60"
			)}
		>
			<span className="grid size-5 shrink-0 place-items-center">{icon}</span>
			<span className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
				<span className="block sm:w-32 sm:shrink-0">{label}</span>
				<span className="block truncate text-muted-foreground">{detail}</span>
			</span>
			{end}
		</Row>
	);
}

function CardDomain({ domain, newsletters, current, sharedDomain, cnameTarget, stagger }) {
	const summary = getDomainSummary(domain);
	const id = String(domain._id);
	return (
		<section style={{ "--stagger": stagger }} className="overflow-hidden rounded-xl bg-card shadow-border animate-enter">
			<div className="flex flex-wrap items-center justify-between gap-3 p-4">
				<div className="flex min-w-0 items-center gap-3">
					<div className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
						<ImageFavicon domain={rootDomain(domain.domain)} size={20} />
					</div>
					<div className="min-w-0">
						<p className="truncate font-medium">{domain.domain}</p>
						<TextStatus {...summary} className="text-xs" />
					</div>
				</div>
				<div className="flex items-center gap-1">
					<ButtonCheckDomain id={id} />
					<DialogRemoveDomain id={id} domain={domain.domain} />
				</div>
			</div>
			{current && <RowsSender domain={domain} newsletters={newsletters} current={current} sharedDomain={sharedDomain} />}
			<ol className="divide-y divide-border/60 border-t border-border/60">
				{getDomainSetup(domain, { cnameTarget }).map((step) => (
					<li key={step.key} className="flex flex-col gap-3 px-4 py-4">
						<div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
							<div className="min-w-0 max-w-xl">
								<p className="text-sm font-medium">{step.title}</p>
								<p className="text-xs text-pretty text-muted-foreground">{step.description}</p>
							</div>
							<TextStatus {...step.status} className="text-xs" />
						</div>
						{step.records.length > 0 && <TableRecords records={step.records} />}
					</li>
				))}
			</ol>
		</section>
	);
}

// The newsletters that send from the domain, then the open newsletter's switch to it.
function RowsSender({ domain, newsletters, current, sharedDomain }) {
	const senders = newsletters.filter(({ fromEmail }) => getEmailDomain(fromEmail) === domain.domain);
	const isCurrentSending = senders.some(({ _id }) => String(_id) === String(current._id));

	return (
		<>
			{senders.map((newsletter) => (
				<p
					key={String(newsletter._id)}
					className="flex items-center gap-2 border-t border-border/60 bg-muted/40 px-4 py-3 text-sm text-pretty text-muted-foreground"
				>
					{domain.verified && <Check className="size-4 shrink-0 text-foreground" />}
					<span className="min-w-0">
						<span className="font-medium text-foreground">{newsletter.name}</span> sends from{" "}
						<span className="font-mono text-[13px] wrap-anywhere text-foreground">{newsletter.fromEmail}</span>
						{!domain.verified && " once it's verified"}
					</span>
				</p>
			))}
			{!isCurrentSending &&
				(domain.verified ? (
					<FormSwitchToDomain
						newsletterId={String(current._id)}
						newsletterName={current.name}
						domainId={String(domain._id)}
						domain={domain.domain}
						defaultLocalPart={getOwnDomainLocalPart(current.fromEmail, sharedDomain)}
					/>
				) : (
					<p className="border-t border-border/60 bg-muted/40 px-4 py-3 text-sm text-pretty text-muted-foreground">
						Once it&apos;s verified, you can send <span className="font-medium text-foreground">{current.name}</span> from it here.
					</p>
				))}
		</>
	);
}

function TableRecords({ records }) {
	return (
		<div className="overflow-x-auto rounded-lg shadow-border">
			<table className="w-full text-sm">
				<thead>
					<tr className="text-left text-xs text-muted-foreground">
						<th className="w-16 py-2 pl-3 font-normal">Type</th>
						<th className="py-2 pr-2 font-normal">Name</th>
						<th className="py-2 pr-3 font-normal">Value</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-border/60 border-t border-border/60">
					{records.map((record) => (
						<tr key={`${record.type}-${record.name}-${record.value}`}>
							<td className="py-2 pl-3 align-middle font-mono text-xs text-muted-foreground">{record.type}</td>
							<td className="max-w-0 py-2 pr-2 align-middle">
								<div className="flex items-center gap-1">
									<span className="truncate font-mono text-xs">{record.name}</span>
									<ButtonCopy value={record.name} label="Copy name" />
								</div>
							</td>
							<td className="max-w-0 py-2 pr-3 align-middle">
								<div className="flex items-center gap-1">
									<span className="truncate font-mono text-xs">{record.value}</span>
									<ButtonCopy value={record.value} label="Copy value" />
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}

function TextStatus({ label, tone, className }) {
	return (
		<span className={cn("flex items-center gap-2 text-muted-foreground", className)}>
			<span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT_TONES[tone])} />
			{label}
		</span>
	);
}

const DOT_TONES = {
	good: "bg-emerald-500",
	wait: "bg-amber-500",
	bad: "bg-red-500",
	none: "bg-zinc-300 dark:bg-zinc-600",
};
