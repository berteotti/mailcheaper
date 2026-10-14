# Security

Mailcheap is provided as is, with no security support and no promise of fixes. If you run it, you're responsible for your deployment: keep dependencies updated and review changes before you deploy them.

## What's built in

- One admin login. Login attempts are rate limited per IP, and every login, new API key and send is logged and, with `ALERT_FROM` set, emailed to `ADMIN_EMAIL`.
- Mailcheap refuses to start with an `ADMIN_PASSWORD` under 12 characters or a `SESSION_SECRET` under 32.
- Sessions last 7 days, in an httpOnly cookie (`__Host-` prefixed in production) signed with a key derived from `SESSION_SECRET`. Changing `ADMIN_PASSWORD` or `ADMIN_EMAIL` signs out every session.
- Every dashboard page, API route and server action checks the session. Public routes are limited to what readers, mail providers and AWS SNS need, plus one internal cache-refresh route that requires a key derived from `SESSION_SECRET`. Background jobs have no HTTP endpoint: they run from a Cloudflare Queue and cron in a separate Worker without a public URL.
- API keys are stored as SHA-256 hashes and can be revoked.
- Unsubscribe, confirmation, "keep sending it" and tracking links are signed with keys derived from `SESSION_SECRET`. Rotating it logs you out and breaks those links in emails already sent.
- SES webhooks only accept messages signed by AWS SNS for the topic in `SES_SNS_TOPIC_ARN`, with certificates from `https://sns.<region>.amazonaws.com/SimpleNotificationService-*.pem` only.
- Public endpoints (signup form, signup API, unsubscribe, views, login) are rate limited by Durable Objects shared across every Worker instance; if they fail, each isolate counts in memory and an alert goes out. Client IPs come from Cloudflare's `CF-Connecting-IP`, never from client-supplied forwarded-for headers.
- Issue HTML shown inline on the archive goes through an allowlist cleaner, then `sanitize-html`, every time the page renders. HTML issues, including every one created through the API, render in a sandboxed iframe without scripts.
- Every response carries a Content Security Policy (no framing, no plugins, no inline event handlers, forms and `<base>` limited to the app's origin) and HSTS.
- Secrets (`ADMIN_PASSWORD`, `SESSION_SECRET`, SES keys) are Worker secrets set by the Alchemy deploy, never committed: `.env*` and `.alchemy/` are ignored by Git. Database backups go to a private R2 bucket; uploaded images to a separate public one, validated by their first bytes.
- SES sends are never retried blindly: an attempt SES didn't answer is marked unconfirmed rather than resent.
- Click tracking only redirects to links signed by the app, so it can't be used as an open redirect.

## The archive's domain

Issue pages show HTML that came from the editor and from API keys. Give each newsletter its own archive domain (`ARCHIVE_HOSTS`): that HTML then never shares the dashboard's origin, and the app domain's `/archive` pages redirect there. Without one, the archive stays on the app domain, protected by the sanitizer, the sandboxed frame and the Content Security Policy.

## Reporting a vulnerability

There's no support channel. If you find a problem, fix it in your own deployment. You can also open a pull request, but it may not be reviewed.
