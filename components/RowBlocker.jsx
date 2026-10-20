// What keeps a deletion from going ahead, in a settings card: what to do, and the way to do it.
export default function RowBlocker({ icon: Icon, title, text, children }) {
	return (
		<div className="flex gap-3 px-4 py-3">
			<span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
				<Icon className="size-4" />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-2.5">
				<div className="flex flex-col gap-0.5">
					<p className="text-sm font-medium">{title}</p>
					<p className="text-sm text-pretty text-muted-foreground">{text}</p>
				</div>
				{children}
			</div>
		</div>
	);
}
