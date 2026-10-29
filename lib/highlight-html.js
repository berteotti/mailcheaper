// HTML fields show their code in color (components/InputHtml.jsx): this reads it into tokens, each a run of one kind of
// text. It takes whatever is typed, half-written tags included, in one pass, and every character lands in exactly one
// token, so the colored copy lines up with the field. The kinds: punctuation (< > / = : ;), tag, attribute, value (with
// its quotes), property (in a style attribute), comment, entity, field (a merge tag) and text.

const SPECIAL_PATTERN = /[<&{]/g;
const SPACE_PATTERN = /\s+/y;
const TAG_NAME_PATTERN = /[^\s/>]+/y;
const ATTRIBUTE_PATTERN = /[^\s=/>]+/y;
const BARE_VALUE_PATTERN = /[^\s>]+/y;
const ENTITY_PATTERN = /&(?:#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{0,31});/iy;
const FIELD_PATTERN = /\{\{[^{}]{0,200}\}\}/y;
const FIELD_SPLIT_PATTERN = /(\{\{[^{}]{0,200}\}\})/;
// Browsers read what's in these as text, up to their end tag.
const RAW_TEXT_END = Object.fromEntries(["script", "style", "textarea", "title", "xmp"].map((name) => [name, new RegExp(`</${name}(?=[\\s/>]|$)`, "gi")]));

function read(pattern, source, index) {
	pattern.lastIndex = index;
	return pattern.exec(source)?.[0] ?? "";
}

function nextSpecial(source, index) {
	SPECIAL_PATTERN.lastIndex = index;
	return SPECIAL_PATTERN.exec(source)?.index ?? source.length;
}

export function highlightHtml(source) {
	const text = String(source ?? "");
	const tokens = [];
	const push = (type, value) => {
		if (!value) return;
		const last = tokens.at(-1);
		if (last?.type === type) last.text += value;
		else tokens.push({ type, text: value });
	};
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		const markupEnd = char === "<" ? readMarkup(text, index, push) : index;
		if (markupEnd > index) {
			index = markupEnd;
			continue;
		}
		const pattern = char === "&" ? ENTITY_PATTERN : char === "{" ? FIELD_PATTERN : null;
		const special = pattern ? read(pattern, text, index) : "";
		if (special) {
			push(char === "&" ? "entity" : "field", special);
			index += special.length;
			continue;
		}
		const end = nextSpecial(text, index + 1);
		push("text", text.slice(index, end));
		index = end;
	}
	return tokens;
}

// A comment, a declaration like <!DOCTYPE html> or a tag at index, or index itself when the "<" opens none.
function readMarkup(source, index, push) {
	if (source.startsWith("<!--", index)) {
		const end = source.indexOf("-->", index + 4);
		const stop = end === -1 ? source.length : end + 3;
		push("comment", source.slice(index, stop));
		return stop;
	}
	const next = source[index + 1] ?? "";
	if (next === "!" || next === "?") {
		const end = source.indexOf(">", index);
		const stop = end === -1 ? source.length : end + 1;
		push("comment", source.slice(index, stop));
		return stop;
	}
	const isEnd = next === "/";
	const open = isEnd ? "</" : "<";
	if (!/[a-z]/i.test(source[index + open.length] ?? "")) return index;
	const name = read(TAG_NAME_PATTERN, source, index + open.length);
	push("punctuation", open);
	push("tag", name);
	return readAttributes(source, index + open.length + name.length, push, isEnd ? null : name.toLowerCase());
}

// Up to the tag's ">", then what a script or a style holds, as text. rawName: a start tag's name.
function readAttributes(source, start, push, rawName) {
	let index = start;
	while (index < source.length) {
		const space = read(SPACE_PATTERN, source, index);
		if (space) {
			push("text", space);
			index += space.length;
			continue;
		}
		const char = source[index];
		if (char === ">" || char === "/") {
			push("punctuation", char);
			index += 1;
			if (char === ">") return readRawText(source, index, push, rawName);
			continue;
		}
		const attribute = read(ATTRIBUTE_PATTERN, source, index);
		if (!attribute) {
			push("punctuation", char);
			index += 1;
			continue;
		}
		push("attribute", attribute);
		index += attribute.length;
		const before = read(SPACE_PATTERN, source, index);
		if (source[index + before.length] !== "=") continue;
		push("text", before);
		push("punctuation", "=");
		index += before.length + 1;
		const after = read(SPACE_PATTERN, source, index);
		push("text", after);
		index += after.length;
		const value = readValue(source, index);
		pushValue(value, attribute.toLowerCase() === "style", push);
		index += value.length;
	}
	return index;
}

function readValue(source, index) {
	const quote = source[index];
	if (quote !== '"' && quote !== "'") return read(BARE_VALUE_PATTERN, source, index);
	const end = source.indexOf(quote, index + 1);
	return source.slice(index, end === -1 ? source.length : end + 1);
}

function readRawText(source, index, push, rawName) {
	const endTag = RAW_TEXT_END[rawName];
	if (!endTag) return index;
	endTag.lastIndex = index;
	const end = endTag.exec(source)?.index ?? source.length;
	push("text", source.slice(index, end));
	return end;
}

// A value with its quotes, its merge tags apart. A style's declarations show their properties apart from their values.
function pushValue(value, isStyle, push) {
	const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
	const closing = quote && value.length > 1 && value.endsWith(quote) ? quote : "";
	const inner = value.slice(quote.length, value.length - closing.length);
	push("value", quote);
	if (isStyle) pushStyle(inner, push);
	else pushWithFields("value", inner, push);
	push("value", closing);
}

function pushStyle(css, push) {
	for (const part of css.split(/(;)/)) {
		if (part === ";") {
			push("punctuation", part);
			continue;
		}
		const colon = part.indexOf(":");
		if (colon === -1) {
			pushWithFields("property", part, push);
			continue;
		}
		pushWithFields("property", part.slice(0, colon), push);
		push("punctuation", ":");
		pushWithFields("value", part.slice(colon + 1), push);
	}
}

function pushWithFields(type, text, push) {
	text.split(FIELD_SPLIT_PATTERN).forEach((part, index) => push(index % 2 ? "field" : type, part));
}
