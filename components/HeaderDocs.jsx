export default function HeaderDocs({ kicker, title, children }) {
	return (
		<header className="mb-10 max-w-2xl animate-enter">
			<p className="mb-3 font-mono text-[11px] tracking-wider text-muted-foreground uppercase">{kicker}</p>
			<h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h1>
			{children && <div className="mt-4 text-[17px] leading-8 text-pretty text-muted-foreground">{children}</div>}
		</header>
	);
}
