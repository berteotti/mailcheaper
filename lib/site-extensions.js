// What MailCheap Cloud's marketing site adds to the pages every server shares, on MailCheap Cloud only.
// next.config.mjs and tests/setup/hooks.mjs resolve this module to lib/marketing/site-extensions.js when that file
// exists. This default, the open source's, adds nothing. What they put on the page is in components/SiteExtensions.jsx.
export const siteExtensions = {
	// proxy.js renders landingPath at / for signed-out visitors and lets publicPages, and the paths isPublicPath
	// accepts, open without a session; a self-hosted server answers 404 for them. The sitemap lists publicPages.
	landingPath: null,
	publicPages: [],
	isPublicPath: () => false,
	headerLinks: [],
	headerAction: null,
	// { tagline, columns, company } in place of the footer's own.
	footer: null,
	twitterCreator: null,
	// A step only the server sees (a new account, a newsletter set up), for the analytics on the browser's next page.
	sendGoalOnNextPage: async () => {},
	// What the analytics needs on a Checkout session to attribute the payment.
	readCheckoutAttribution: async () => ({}),
};
