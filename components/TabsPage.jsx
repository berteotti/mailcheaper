import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

// A page's details in tabs under what it always shows, like a sent campaign's: a line of tabs, each with its icon.
// tabs: { value, icon, label } in order; the panels are its children.
export default function TabsPage({ tabs, defaultValue = tabs[0]?.value, style, className, children }) {
	return (
		<Tabs defaultValue={defaultValue} style={style} className={cn("gap-4 animate-enter", className)}>
			<TabsList
				variant="line"
				className="w-full justify-start gap-6 overflow-x-auto rounded-none border-b border-border/60 p-0 group-data-horizontal/tabs:h-11 [scrollbar-width:none]"
			>
				{tabs.map(({ value, icon: Icon, label }) => (
					<TabsTrigger
						key={value}
						value={value}
						className="h-full flex-none gap-2 px-0.5 group-data-horizontal/tabs:after:-bottom-px [&_svg:not([class*='size-'])]:size-3.5"
					>
						<Icon aria-hidden="true" />
						{label}
					</TabsTrigger>
				))}
			</TabsList>
			{children}
		</Tabs>
	);
}

// Every tab's panel is rendered, the others hidden: they open at once, and the server's HTML has them all.
export function PanelTab({ value, className, children }) {
	return (
		<TabsContent value={value} forceMount className={cn("animate-fade-in data-[state=inactive]:hidden", className)}>
			{children}
		</TabsContent>
	);
}
