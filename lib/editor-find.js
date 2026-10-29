// Where the editor's document first has words, { from, to }, ignoring case: the review step's fixes select the words
// its warnings and tips quote. Words are found within a paragraph, a heading or a button, as quoted.
export function findWords(doc, words) {
	const needle = String(words ?? "").toLowerCase();
	if (!needle) return null;
	let found = null;
	doc.descendants((node, pos) => {
		if (found) return false;
		if (!node.isTextblock) return true;
		// An inline node that isn't text, like a picture or a line break, takes positions too: a character each keeps the
		// count.
		let text = "";
		node.forEach((child) => {
			text += child.isText ? child.text.replaceAll("\u00a0", " ") : "\ufffc".repeat(child.nodeSize);
		});
		const index = text.toLowerCase().indexOf(needle);
		if (index >= 0) found = { from: pos + 1 + index, to: pos + 1 + index + needle.length };
		return false;
	});
	return found;
}
