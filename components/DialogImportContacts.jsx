"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, FileUp, Loader2, Upload } from "lucide-react";
import Papa from "papaparse";
import { toast } from "sonner";
import { importContacts } from "@/app/(app)/contacts/actions";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MAX_IMPORT_ROWS_PER_REQUEST, mapColumns, normalizeImportRow } from "@/lib/csv-import";
import { CONSENT_TEXT, DROP_REASONS, addDropped } from "@/lib/import-checks";
import { formatNumber } from "@/lib/format";
import { NO_LANGUAGE, getLanguageName } from "@/lib/languages";
import { cn } from "@/lib/utils";

// Into the newsletter the page shows.
export default function DialogImportContacts({ newsletter, label = "Import", variant = "outline" }) {
	const router = useRouter();
	const [isOpen, setIsOpen] = useState(false);
	const [mode, setMode] = useState("file");
	const [file, setFile] = useState(null);
	const [parsed, setParsed] = useState(null);
	const [progress, setProgress] = useState(null);
	const [hasConsent, setHasConsent] = useState(false);
	const [leftOutLanguages, setLeftOutLanguages] = useState([]);
	const [summary, setSummary] = useState(null);
	const [isImporting, startImporting] = useTransition();

	// Invalid rows still go to the server, which checks every row again and counts them in the import.
	const { rows, invalidRows, duplicates } = useMemo(() => {
		if (!parsed) return { rows: [], invalidRows: [], duplicates: 0 };
		const options = mode === "dormant" ? { status: "dormant" } : {};
		const byEmail = new Map();
		const invalid = [];
		for (const row of parsed.rows) {
			const normalized = normalizeImportRow(row, parsed.columns, options);
			if (!normalized)
				invalid.push({ email: String(row[parsed.columns.email] ?? "").slice(0, 254), status: "active" });
			else if (!byEmail.has(normalized.email)) byEmail.set(normalized.email, normalized);
		}
		return {
			rows: [...byEmail.values()],
			invalidRows: invalid,
			duplicates: parsed.rows.length - invalid.length - byEmail.size,
		};
	}, [parsed, mode]);
	// Each language in the file and the rows without one (NO_LANGUAGE), when the file has languages at all.
	const languageCounts = useMemo(() => {
		if (!rows.some(({ language }) => language)) return [];
		return Object.entries(Object.groupBy(rows, ({ language }) => language ?? NO_LANGUAGE))
			.map(([language, group]) => [language, group.length])
			.sort(([, a], [, b]) => b - a);
	}, [rows]);
	// Every row still goes to the server, which leaves out the languages left out here.
	const keptRows = useMemo(
		() => rows.filter(({ language }) => !leftOutLanguages.includes(language ?? NO_LANGUAGE)),
		[rows, leftOutLanguages],
	);
	const statusCounts = useMemo(
		() =>
			Object.entries(Object.groupBy(keptRows, ({ status }) => status)).map(([status, group]) => [
				status,
				group.length,
			]),
		[keptRows],
	);

	function reset() {
		setFile(null);
		setParsed(null);
		setProgress(null);
		setHasConsent(false);
		setLeftOutLanguages([]);
		setSummary(null);
	}

	function toggleLanguage(language) {
		setLeftOutLanguages((current) =>
			current.includes(language) ? current.filter((key) => key !== language) : [...current, language],
		);
	}

	function onFileChange(event) {
		const selected = event.target.files?.[0];
		if (!selected) return;
		setFile(selected);
		Papa.parse(selected, {
			header: true,
			skipEmptyLines: true,
			complete: ({ data, meta }) => {
				const columns = mapColumns(meta.fields ?? []);
				if (!columns.email) {
					toast.error("No email column found");
					return reset();
				}
				setParsed({ rows: data, columns });
			},
			error: () => toast.error("Could not read this file"),
		});
	}

	function runImport() {
		startImporting(async () => {
			const allRows = [...rows, ...invalidRows];
			const languages =
				leftOutLanguages.length > 0
					? languageCounts.map(([language]) => language).filter((language) => !leftOutLanguages.includes(language))
					: undefined;
			const totals = { created: 0, existing: 0, dropped: {} };
			let importId;
			for (let start = 0; start < allRows.length; start += MAX_IMPORT_ROWS_PER_REQUEST) {
				setProgress(start / allRows.length);
				const result = await importContacts({
					newsletterId: newsletter.id,
					consent: hasConsent,
					importId,
					duplicates: importId ? 0 : duplicates,
					languages,
					rows: allRows.slice(start, start + MAX_IMPORT_ROWS_PER_REQUEST),
				});
				if (result?.error) {
					toast.error(result.error);
					return setProgress(null);
				}
				importId = result.importId;
				totals.created += result.created;
				totals.existing += result.existing;
				totals.dropped = addDropped(totals.dropped, result.dropped);
			}
			setProgress(null);
			setSummary(totals);
			router.refresh();
		});
	}

	return (
		<Dialog
			open={isOpen}
			onOpenChange={(open) => {
				if (isImporting) return;
				setIsOpen(open);
				if (!open) reset();
			}}
		>
			<DialogTrigger asChild>
				<Button variant={variant} disabled={!newsletter}>
					<Upload data-icon="inline-start" />
					{label}
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Import contacts</DialogTitle>
					<DialogDescription>
						Into <span className="font-medium text-foreground">{newsletter?.name}</span>. A CSV with an email column:
						exports from beehiiv, Substack, Mailchimp, Kit and other platforms work as they are. Existing contacts keep
						their status.
					</DialogDescription>
				</DialogHeader>

				{summary ? (
					<SummaryImport summary={summary} />
				) : (
					<div className="flex flex-col gap-3">
						<Select value={mode} onValueChange={setMode} disabled={isImporting}>
							<SelectTrigger className="h-9 w-full" aria-label="Status">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="file">Status from file</SelectItem>
								<SelectItem value="dormant">Import as dormant</SelectItem>
							</SelectContent>
						</Select>

						<label
							className={cn(
								"flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl px-4 py-8 text-center shadow-border transition-[box-shadow,background-color] duration-150 hover:bg-muted/40 hover:shadow-border-hover",
								isImporting && "pointer-events-none opacity-60",
							)}
						>
							<FileUp className="size-5 text-muted-foreground" />
							<span className="max-w-full truncate text-sm font-medium">
								{file ? file.name : "Choose a CSV file"}
							</span>
							{parsed && (
								<span className="text-xs text-muted-foreground tabular-nums">
									{formatNumber(rows.length)} unique valid of {formatNumber(parsed.rows.length)} rows
								</span>
							)}
							<input type="file" accept=".csv,text/csv" className="sr-only" onChange={onFileChange} />
						</label>

						{languageCounts.length > 0 && (
							<div className="flex flex-col gap-1.5">
								<p className="text-xs text-muted-foreground">Only the languages you keep are added.</p>
								<div className="flex flex-wrap gap-1.5">
									{languageCounts.map(([language, count]) => {
										const isKept = !leftOutLanguages.includes(language);
										return (
											<button
												key={language}
												type="button"
												aria-pressed={isKept}
												disabled={isImporting}
												onClick={() => toggleLanguage(language)}
												className={cn(
													"inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs tabular-nums transition-[color,background-color,box-shadow] duration-150 disabled:opacity-60",
													isKept
														? "bg-foreground text-background"
														: "text-muted-foreground shadow-border hover:bg-muted hover:text-foreground",
												)}
											>
												{isKept && <Check className="size-3" />}
												{language === NO_LANGUAGE ? "No language" : getLanguageName(language)}
												<span className={isKept ? "opacity-70" : "text-foreground"}>{formatNumber(count)}</span>
											</button>
										);
									})}
								</div>
							</div>
						)}

						{statusCounts.length > 0 && (
							<div className="flex flex-wrap gap-1.5">
								{statusCounts.map(([status, count]) => (
									<span
										key={status}
										className="inline-flex h-6 items-center gap-1 rounded-full bg-muted px-2 text-xs text-muted-foreground tabular-nums"
									>
										{status} <span className="text-foreground">{formatNumber(count)}</span>
									</span>
								))}
							</div>
						)}

						<label className="flex items-start gap-2.5 text-sm">
							<input
								type="checkbox"
								checked={hasConsent}
								onChange={(event) => setHasConsent(event.target.checked)}
								disabled={isImporting}
								className="mt-0.5 size-4 shrink-0 accent-foreground"
							/>
							<span>
								{CONSENT_TEXT}
								<span className="block text-xs text-muted-foreground">
									Role addresses, throwaway inboxes and addresses that bounced or complained are left out.
								</span>
							</span>
						</label>

						{progress !== null && (
							<div className="h-1.5 overflow-hidden rounded-full bg-muted">
								<div
									className="h-full rounded-full bg-foreground transition-[width] duration-300"
									style={{ width: `${Math.max(progress, 0.02) * 100}%` }}
								/>
							</div>
						)}
					</div>
				)}

				<DialogFooter>
					{summary ? (
						<Button
							onClick={() => {
								setIsOpen(false);
								reset();
							}}
							className="min-w-24"
						>
							Done
						</Button>
					) : (
						<Button
							onClick={runImport}
							disabled={!newsletter || keptRows.length === 0 || !hasConsent || isImporting}
							className="min-w-24"
						>
							{isImporting ? (
								<Loader2 className="animate-spin" />
							) : (
								`Import ${keptRows.length ? formatNumber(keptRows.length) : ""}`.trim()
							)}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function SummaryImport({ summary }) {
	const dropped = Object.entries(summary.dropped).filter(([, count]) => count > 0);
	return (
		<div className="flex flex-col gap-3 text-sm">
			<p>
				<span className="font-medium tabular-nums">{formatNumber(summary.created)}</span> added,{" "}
				<span className="font-medium tabular-nums">{formatNumber(summary.existing)}</span> already there.
			</p>
			{dropped.length > 0 ? (
				<div className="rounded-xl px-4 py-3 shadow-border">
					<p className="mb-2 font-medium">
						{formatNumber(dropped.reduce((sum, [, count]) => sum + count, 0))} left out
					</p>
					<ul className="flex flex-col gap-1 text-muted-foreground">
						{dropped.map(([reason, count]) => (
							<li key={reason} className="flex justify-between gap-4">
								<span>{DROP_REASONS[reason]}</span>
								<span className="text-foreground tabular-nums">{formatNumber(count)}</span>
							</li>
						))}
					</ul>
				</div>
			) : (
				<p className="text-muted-foreground">Nothing left out.</p>
			)}
		</div>
	);
}
