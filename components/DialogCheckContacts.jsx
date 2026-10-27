"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, MailCheck } from "lucide-react";
import { toast } from "sonner";
import { deleteContacts, findUnreachableContacts } from "@/app/(app)/contacts/actions";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { formatNumber } from "@/lib/format";

const DELETES_PER_CALL = 100;
const REASONS = { invalid: "Not a valid address", noMail: "The domain can't receive email" };

// The newsletter's active, pending and dormant contacts (count), checked a page at a time from the moment it opens.
// Every address that can't get email starts ticked: the user deletes the ticked ones and keeps the rest.
export default function DialogCheckContacts({ newsletter, count }) {
	const router = useRouter();
	const [isOpen, setIsOpen] = useState(false);
	const [checked, setChecked] = useState(0);
	const [found, setFound] = useState(null);
	const [selected, setSelected] = useState(() => new Set());
	const [isDeleting, startDeleting] = useTransition();
	// Each check's number: closing the dialog moves it on, which stops the check that was running.
	const run = useRef(0);

	async function check() {
		const current = ++run.current;
		const contacts = [];
		let total = 0;
		let cursor = null;
		do {
			const result = await findUnreachableContacts({ newsletterId: newsletter.id, cursor });
			if (run.current !== current) return;
			if (result?.error) {
				toast.error(result.error);
				return changeOpen(false);
			}
			contacts.push(...result.contacts);
			total += result.checked;
			setChecked(total);
			cursor = result.nextCursor;
		} while (cursor);
		setFound(contacts);
		setSelected(new Set(contacts.map(({ id }) => id)));
	}

	function changeOpen(open) {
		if (isDeleting) return;
		setIsOpen(open);
		run.current++;
		setChecked(0);
		setFound(null);
		setSelected(new Set());
		if (open) check();
	}

	function toggle(id) {
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	function remove() {
		startDeleting(async () => {
			const ids = [...selected];
			let deleted = 0;
			let kept = 0;
			for (let start = 0; start < ids.length; start += DELETES_PER_CALL) {
				const result = await deleteContacts(ids.slice(start, start + DELETES_PER_CALL));
				if (result?.error) {
					toast.error(result.error);
					break;
				}
				deleted += result.deleted.length;
				kept += result.kept.length;
			}
			if (deleted > 0) toast.success(`${formatNumber(deleted)} ${deleted === 1 ? "contact" : "contacts"} deleted`);
			if (kept > 0) toast(`${formatNumber(kept)} kept: an email to them is going out, or one bounced or got a complaint`);
			router.refresh();
			setIsOpen(false);
		});
	}

	const isChecking = found === null;

	return (
		<Dialog open={isOpen} onOpenChange={changeOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" disabled={!newsletter}>
					<MailCheck data-icon="inline-start" />
					Check addresses
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Check addresses</DialogTitle>
					<DialogDescription>
						{isChecking
							? "Looking for addresses that can't get email: invalid ones, misspelled domains and domains that can't receive email."
							: found.length === 0
								? `All ${formatNumber(checked)} addresses can get email.`
								: `${formatNumber(found.length)} of ${formatNumber(checked)} can't get email. Emails to them bounce, and bounces count against your account.`}
					</DialogDescription>
				</DialogHeader>

				{isChecking ? (
					<div className="flex flex-col gap-2">
						<div className="h-1.5 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-foreground transition-[width] duration-300"
								style={{ width: `${Math.max(Math.min(checked / count, 1), 0.02) * 100}%` }}
							/>
						</div>
						<p className="text-xs text-muted-foreground tabular-nums">
							{formatNumber(checked)} of {formatNumber(count)} checked
						</p>
					</div>
				) : (
					found.length > 0 && (
						<div className="flex flex-col gap-2">
							<label className="flex items-center gap-2.5 px-3 text-sm text-muted-foreground">
								<input
									type="checkbox"
									checked={selected.size === found.length}
									onChange={(event) =>
										setSelected(new Set(event.target.checked ? found.map(({ id }) => id) : []))
									}
									disabled={isDeleting}
									className="size-4 shrink-0 accent-foreground"
								/>
								Select all
							</label>
							<ul className="max-h-72 divide-y overflow-y-auto rounded-xl shadow-border">
								{found.map((contact) => (
									<li key={contact.id}>
										<label className="flex cursor-pointer items-start gap-2.5 px-3 py-2 text-sm">
											<input
												type="checkbox"
												checked={selected.has(contact.id)}
												onChange={() => toggle(contact.id)}
												disabled={isDeleting}
												className="mt-0.5 size-4 shrink-0 accent-foreground"
											/>
											<span className="flex min-w-0 flex-col">
												<span className="truncate font-medium">{contact.email}</span>
												<span className="truncate text-xs text-muted-foreground">
													{contact.reason === "typo" && contact.suggestion
														? `Did you mean ${contact.suggestion}?`
														: (REASONS[contact.reason] ?? "Misspelled domain")}
												</span>
											</span>
										</label>
									</li>
								))}
							</ul>
						</div>
					)
				)}

				<DialogFooter>
					{isChecking || found.length === 0 ? (
						<Button variant={isChecking ? "outline" : "default"} onClick={() => changeOpen(false)} className="min-w-24">
							{isChecking ? "Stop" : "Done"}
						</Button>
					) : (
						<>
							<Button variant="outline" onClick={() => changeOpen(false)} disabled={isDeleting}>
								Keep all
							</Button>
							<Button variant="destructive" onClick={remove} disabled={selected.size === 0 || isDeleting} className="min-w-24">
								{isDeleting ? <Loader2 className="animate-spin" /> : `Delete ${formatNumber(selected.size)}`}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
