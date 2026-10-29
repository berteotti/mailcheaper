// A link clicked in a preview's frame would load its page in place of the email. A web link opens in a new tab instead,
// with nothing of the dashboard passed to it, and a mailto: link opens the mail app; any other, like a "#", does
// nothing. The email itself is left as it is. Each new email is a new document, so each load listens again.
export function openLinksOutside(frame) {
	const open = (event) => {
		const link = event.target.closest?.("a[href], area[href]");
		if (!link || event.button > 1) return;
		event.preventDefault();
		const url = readLinkUrl(link.getAttribute("href"));
		if (url?.protocol === "mailto:") window.location.assign(url.href);
		else if (url) window.open(url.href, "_blank", "noopener,noreferrer");
	};
	frame.contentDocument?.addEventListener("click", open);
	frame.contentDocument?.addEventListener("auxclick", open);
}

// Only a full web or mailto: address: a relative one would resolve against the dashboard's own page.
function readLinkUrl(href) {
	try {
		const url = new URL(String(href ?? "").trim());
		return ["http:", "https:", "mailto:"].includes(url.protocol) ? url : null;
	} catch {
		return null;
	}
}
