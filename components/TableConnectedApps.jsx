import Link from "next/link";
import { AppWindow } from "lucide-react";
import { revokeConnectedApp } from "@/app/(app)/api-keys/actions";
import ButtonCopy from "@/components/ButtonCopy";
import ButtonRevoke from "@/components/ButtonRevoke";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatDate, formatRelative } from "@/lib/format";

// Apps connected with OAuth (ChatGPT, Claude): each has full access until it's revoked here.
export default function TableConnectedApps({ apps, mcpUrl }) {
	if (apps.length === 0) {
		return (
			<div className="flex flex-col gap-3 rounded-xl px-4 py-3.5 shadow-border sm:flex-row sm:items-center sm:justify-between">
				<p className="text-sm text-pretty text-muted-foreground">
					ChatGPT, Claude and Grok Bot connect with your MailCheap sign-in instead of a key. Add this URL to the app,{" "}
					<Link href="/docs/mcp#chatgpt" className="text-foreground underline decoration-foreground/30 underline-offset-4 hover:decoration-foreground">
						step by step
					</Link>
					.
				</p>
				<div className="flex shrink-0 items-center gap-1 rounded-lg bg-muted/60 py-1 pr-1 pl-3">
					<code className="font-mono text-xs">{mcpUrl}</code>
					<ButtonCopy value={mcpUrl} label="Copy URL" />
				</div>
			</div>
		);
	}

	return (
		<div className="overflow-hidden rounded-xl shadow-border">
			<Table>
				<TableHeader>
					<TableRow className="hover:bg-transparent">
						<TableHead className="pl-4">App</TableHead>
						<TableHead className="hidden sm:table-cell">Connected</TableHead>
						<TableHead className="hidden sm:table-cell">Last used</TableHead>
						<TableHead className="w-24 pr-2" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{apps.map((app) => (
						<TableRow key={app.id}>
							<TableCell className="max-w-0 py-2.5 pl-4 sm:w-1/2">
								<div className="flex items-center gap-2.5">
									<span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
										<AppWindow className="size-3.5" />
									</span>
									<span className="min-w-0">
										<span className="block truncate font-medium">{app.name}</span>
										{app.host && app.host !== app.name && <span className="block truncate text-xs text-muted-foreground">{app.host}</span>}
									</span>
								</div>
							</TableCell>
							<TableCell className="hidden text-muted-foreground sm:table-cell">{formatDate(app.createdAt)}</TableCell>
							<TableCell className="hidden text-muted-foreground sm:table-cell">
								{app.lastUsedAt ? formatRelative(app.lastUsedAt) : "Never"}
							</TableCell>
							<TableCell className="pr-2 text-right">
								<ButtonRevoke
									id={app.id}
									revoke={revokeConnectedApp}
									confirmMessage={`Disconnect ${app.name}? It loses access to your account now.`}
									successMessage="App disconnected"
								/>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}
