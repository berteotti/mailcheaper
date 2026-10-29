// A shortcut as the keyboard in use writes it: ⌘K on Apple's, Ctrl K on the others. Browser only.
export function formatShortcut(key) {
	const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
	return /mac|iphone|ipad|ipod/i.test(platform) ? `⌘${key}` : `Ctrl ${key}`;
}
