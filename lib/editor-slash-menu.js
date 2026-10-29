// The editor's slash menu (components/MenuSlash.jsx): what it lists, and where it shows.

export const SLASH_BACK = Object.freeze({ id: "back" });
export const SLASH_FIELDS = Object.freeze({ id: "fields", title: "Contact fields" });
// Three options' worth: the least a short screen leaves the menu.
const MIN_MENU_HEIGHT = 120;

// Without a search, the blocks, then one entry for the contact fields, which opens them: the first and last name, with
// the way back above them. A search finds blocks and fields alike, the fields in a group of their own under the blocks;
// among the fields, it narrows them. items: the blocks and the fields (isField). The header and the footer stay put
// while the groups scroll.
export function getSlashMenu(items, { query = "", view = "blocks" } = {}) {
	const search = query.toLowerCase().trim();
	const found = items.filter(({ title, keywords }) => `${title} ${keywords}`.toLowerCase().includes(search));
	const blocks = found.filter((item) => !item.isField);
	const fields = found.filter((item) => item.isField);
	if (view === "fields") return { header: SLASH_BACK, groups: [{ items: fields }], footer: null };
	if (!search) return { header: null, groups: [{ items: blocks }], footer: fields.length > 0 ? SLASH_FIELDS : null };
	const groups = [{ items: blocks }, { label: SLASH_FIELDS.title, items: fields }];
	return { header: null, groups: groups.filter((group) => group.items.length > 0), footer: null };
}

// What the arrow keys go through, in the order they show.
export function listSlashOptions({ header, groups, footer }) {
	return [header, ...groups.flatMap((group) => group.items), footer].filter(Boolean);
}

// The menu shows below the caret, or above it where only there it fits, as Floating UI's flip places it; when neither
// fits, the page scrolls by just enough for it to show whole below, never so far that the caret leaves the area.
// maxHeight: what the area leaves next to the caret's line, so a menu that could never fit (a phone with its keyboard
// open) shrinks and scrolls inside. area: the part of the screen the page's own bars leave; it and caret in the
// viewport's pixels, as getBoundingClientRect gives them. gap: between the caret and the menu.
export function fitMenu({ caret, height, area, gap = 0 }) {
	const maxHeight = Math.max(MIN_MENU_HEIGHT, Math.floor(area.bottom - area.top - (caret.bottom - caret.top) - gap));
	const below = area.bottom - caret.bottom - gap;
	const above = caret.top - area.top - gap;
	if (height <= below || height <= above) return { maxHeight, scroll: 0 };
	return { maxHeight, scroll: Math.max(0, Math.min(Math.ceil(height - below), Math.floor(caret.top - area.top))) };
}
