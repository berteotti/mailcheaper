import sanitizeHtml from "sanitize-html";
import {
	CONTENT_TAGS,
	HTML_BLOCK_ATTRIBUTES,
	HTML_BLOCK_CSS_MARGIN,
	HTML_BLOCK_CSS_VALUE,
	HTML_BLOCK_STYLES,
	HTML_BLOCK_TAGS,
	KEPT_ATTRIBUTES,
	cleanBlockHtml,
} from "./clean-html.js";

// The cleaners match tags with patterns; this parses the HTML, so whatever they miss can't run on the
// archive page. Client components import clean-html.js and render-email.js, so the package stays here.
const OPTIONS = {
	allowedTags: CONTENT_TAGS,
	allowedAttributes: {
		...KEPT_ATTRIBUTES,
		img: [
			...KEPT_ATTRIBUTES.img,
			{ name: "loading", values: ["lazy"] },
			{ name: "fetchpriority", values: ["high"] },
			{ name: "decoding", values: ["async"] },
		],
		div: [
			{ name: "data-callout", values: [""] },
			{ name: "data-html-block", values: [""] },
			{ name: "data-button", values: [""] },
			{ name: "data-align", values: ["left", "right"] },
		],
	},
	allowedEmptyAttributes: ["alt", "data-callout", "data-html-block", "data-button"],
	allowedSchemes: ["http", "https", "mailto"],
	allowProtocolRelative: false,
	exclusiveFilter: isOffWebImage,
};

// An HTML block's markup (lib/clean-html.js), its inline styles read declaration by declaration. Its pictures load as
// they scroll into view.
const BLOCK_OPTIONS = {
	allowedTags: HTML_BLOCK_TAGS,
	allowedAttributes: {
		...HTML_BLOCK_ATTRIBUTES,
		img: [...HTML_BLOCK_ATTRIBUTES.img, { name: "loading", values: ["lazy"] }, { name: "decoding", values: ["async"] }],
	},
	allowedStyles: {
		"*": Object.fromEntries(HTML_BLOCK_STYLES.map((name) => [name, [name.startsWith("margin") ? HTML_BLOCK_CSS_MARGIN : HTML_BLOCK_CSS_VALUE]])),
	},
	allowedEmptyAttributes: ["alt"],
	allowedSchemes: ["http", "https", "mailto", "tel"],
	allowedSchemesByTag: { img: ["http", "https"] },
	allowProtocolRelative: false,
	exclusiveFilter: isOffWebImage,
	transformTags: { img: (tagName, attribs) => ({ tagName, attribs: { ...attribs, loading: "lazy", decoding: "async" } }) },
};

function isOffWebImage(frame) {
	return frame.tag === "img" && !/^https?:\/\//i.test(frame.attribs.src ?? "");
}

export function sanitizeIssueHtml(html) {
	return sanitizeHtml(html, OPTIONS);
}

export function sanitizeHtmlBlock(html) {
	return sanitizeHtml(cleanBlockHtml(html), BLOCK_OPTIONS);
}
