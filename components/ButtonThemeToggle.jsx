"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// Light, dark, or the device's (System, where everyone starts: ProviderTheme). The button shows the theme in use
// from the page's class, so the server renders it as the browser will.
export default function ButtonThemeToggle() {
	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon" aria-label="Theme">
							<Sun className="animate-icon-in dark:hidden" />
							<Moon className="hidden animate-icon-in dark:block" />
						</Button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent>Theme</TooltipContent>
			</Tooltip>
			<DropdownMenuContent align="end" className="w-36">
				<RadioGroupTheme />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// The three choices, for this button's menu and the account menu's Theme submenu.
export function RadioGroupTheme() {
	const { theme, setTheme } = useTheme();

	return (
		<DropdownMenuRadioGroup value={theme} onValueChange={setTheme}>
			{THEMES.map(({ value, label, icon: Icon }) => (
				<DropdownMenuRadioItem key={value} value={value}>
					<Icon />
					{label}
				</DropdownMenuRadioItem>
			))}
		</DropdownMenuRadioGroup>
	);
}

const THEMES = [
	{ value: "light", label: "Light", icon: Sun },
	{ value: "dark", label: "Dark", icon: Moon },
	{ value: "system", label: "System", icon: Monitor },
];
