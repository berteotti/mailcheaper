# Mailcheap

Mailcheap is a self-hosted newsletter app on Amazon SES. Write an issue, send it to your list, publish it on the web. About $0.10 per 1,000 emails.

![Mailcheap overview](docs/screenshots/overview.webp)

> [!IMPORTANT]
> **No support.** This is a one-time open-source release. Issues are off, and setup questions go unanswered. Fork it, deploy it, make it yours.

## Why

Newsletter platforms charge for every subscriber, every month. With your own SES account you pay for the emails you send: 10,000 readers and 4 issues a month is 40,000 emails, about $4.

Mailcheap is the rest of what a newsletter needs, in one small Next.js app on Cloudflare Workers: an editor, a list, signup forms, unsubscribe handling, bounce and complaint handling, stats and a public archive. One admin, no teams, no plans. Your list stays in your own Cloudflare D1 database.

## Features

**Write and send**

- Editor with a live email preview, slash commands, image uploads and boxes. Markdown and raw HTML work too.
- Checks before every send: subject, preview text, unsubscribe link, size under Gmail's 100 KB clip, postal address, verified domain.
- Test emails, scheduling, and sending in batches through Cloudflare Queues at the rate you set.
- Send in steps: start with your most engaged readers, then send to more.

**Grow the list**

- Several newsletters in one install, each with its own from address, reply-to and postal address.
- A signup form on each newsletter's archive, and a signup API with API keys.
- Confirmed opt-in per newsletter, off by default. Welcome email.
- Rate limits on signups, login, unsubscribes and the API, on by default.

**Keep it healthy**

- SES events (deliveries, bounces, complaints) and a suppression list shared by every newsletter.
- A send pauses itself when bounces pass 2% or complaints pass 0.08%.
- One-click unsubscribe (RFC 8058 `List-Unsubscribe` headers) and an unsubscribe page, with signed links.
- List cleanup, off by default: readers who ignored several issues get one "do you still want this?" email, then stop getting issues.
- Open and click tracking on your own domain, with link scanners filtered out.

**Publish and measure**

- A public archive for each newsletter: issue pages, author page, share images, sitemap. Optional custom domain.
- Overview with subscribers over time, emails per hour, and delivery, open, click, bounce and complaint rates.
- Campaign reports by mailbox provider (Gmail, Outlook, Yahoo, iCloud...).
- Contacts with search, status filters and CSV import from any platform.
- A domains page with each SES identity's DKIM and MAIL FROM status and the DNS records to add.

## Screenshots

| Editor | Campaign report |
| --- | --- |
| ![Editor](docs/screenshots/editor.webp) | ![Campaign report](docs/screenshots/report.webp) |
| **Contacts** | **Public archive** |
| ![Contacts](docs/screenshots/contacts.webp) | ![Public archive](docs/screenshots/archive.webp) |

<details>
<summary>Issue page</summary>

![Issue page](docs/screenshots/issue.webp)

</details>

All names and addresses in the screenshots are made up.

## What you need

| Service | For | Cost |
| --- | --- | --- |
| [Cloudflare Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/) | Hosting (two Workers), D1 database, R2 images and backups, Queues, Durable Objects, cron | $5/month base, plus usage beyond the included amounts |
| [Amazon SES](https://aws.amazon.com/ses/) | Sending | About $0.10 per 1,000 emails |
| Amazon SNS | Delivering SES bounces, complaints and deliveries to Mailcheap | Free at newsletter volumes |
| A domain on Cloudflare (recommended) | Dashboard, email links, images | Your registrar's price |

[Alchemy](https://alchemy.run) creates and wires every Cloudflare resource from [`alchemy.run.ts`](alchemy.run.ts): you never create a database, bucket or queue by hand. The app runs on [vinext](https://vinext.dev), Cloudflare's Vite-based implementation of the Next.js API.

## Setup

Plan for about an hour, most of it waiting for DNS and for AWS to approve production access.

### 1. Install

Node.js 24.11+ (see `.nvmrc`) and npm:

```bash
git clone https://github.com/<you>/mailcheap.git && cd mailcheap
npm ci
cp .env.example .env
```

In `.env`, set `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ characters) and `SESSION_SECRET` (`openssl rand -base64 48`). Generate a new secret for each install and keep it: email links depend on it. `.env` is ignored by Git.

### 2. Connect Alchemy to Cloudflare

Create an Alchemy profile and connect your Cloudflare account (`npx alchemy profile create`, then `npx alchemy profile edit`; `npx alchemy provider cloudflare --help` lists the prerequisites). In CI, set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` instead.

Deployment state lives in your Cloudflare account (`Cloudflare.state()`), so any machine with access can deploy the same stages. **The first `plan`, `deploy` or non-local `dev` creates that state store** (a small Worker, a Durable Object and Secrets Store entries) in the account. Nothing else needs creating by hand.

### 3. Try it locally

```bash
npm run dev
```

This runs `alchemy dev --stage local`: both Workers with local D1, R2, Queues, Durable Objects and cron, state in `.alchemy/` (ignored). Open the printed URL and log in. Nothing is sent while `SENDING_ENABLED` isn't `true`. Never point `dev` at `--stage prod`: it would replace that stage's Workers.

### 4. Deploy

Set `APP_DOMAIN` (and optionally `ASSET_DOMAIN`) to subdomains of a zone on the same Cloudflare account before your first real email: every link in sent emails uses them. Then:

```bash
npm run deploy -- --stage prod
```

Use a separate env file per stage if their values differ (`--env-file .env.prod`). The deploy:

1. creates or reuses D1, the R2 asset and backup buckets, the jobs queue and its dead-letter queue;
2. applies new SQL files from `migrations/` to D1, in order and once each (they're recorded in D1), before the new code goes live;
3. builds and deploys the app Worker (dashboard, APIs, archive, SES webhook, rate-limit and SES-pacing Durable Objects) and the jobs Worker (queue consumer, minute cron, daily backup);
4. prints `url` and `sesWebhookUrl`.

Running it again updates the same resources and keeps their data. In `prod`, D1 and both buckets are retained even if the stack is destroyed. Try `--stage staging` first: each stage has its own resources and secrets.

### 5. Amazon SES and SNS

Use one AWS region for everything below (the examples use `us-east-1`).

1. **Verify a sending domain.** In the SES console, go to **Identities > Create identity > Domain**. Use a subdomain like `mail.example.com`, so your main domain's email is unaffected. Keep Easy DKIM with RSA 2048 and add the 3 CNAME records SES gives you. On Cloudflare DNS, keep them **DNS only** (grey cloud).
2. **Set a custom MAIL FROM domain.** On the identity, open **Custom MAIL FROM domain > Edit**, use `bounce.mail.example.com`, and add the MX and TXT records SES shows. This aligns SPF with your domain.
3. **Add DMARC** if your root domain doesn't have one: a TXT record at `_dmarc.example.com` with `v=DMARC1; p=none;` to start. Gmail and Yahoo require DMARC from bulk senders.
4. **Request production access.** New accounts are in the sandbox (200 emails a day, verified recipients only). In **Account dashboard > Request production access**, pick Marketing, and explain that readers opt in, that bounces and complaints are suppressed automatically, and that every email has one-click unsubscribe. AWS usually answers within a day.
5. **Create a configuration set**, named `mailcheap` for example, under **Configuration sets**. Leave SES open and click tracking off: Mailcheap tracks on your own domain.
6. **Create an SNS topic.** In the SNS console, create a standard topic, like `mailcheap-ses-events`, and copy its ARN. Then switch it to signature version 2, which signs messages with SHA256 instead of SHA1: `aws sns set-topic-attributes --topic-arn <topic-arn> --attribute-name SignatureVersion --attribute-value 2`.
7. **Send SES events to the topic.** In the configuration set, open **Event destinations > Add destination**. Select hard bounces, complaints, deliveries, delivery delays, rejects and rendering failures, then pick Amazon SNS and your topic.
8. **Create an IAM user for Mailcheap** with this policy, then create an access key for it:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["ses:SendEmail", "ses:SendRawEmail"],
      "Resource": [
        "arn:aws:ses:us-east-1:<account-id>:identity/mail.example.com",
        "arn:aws:ses:us-east-1:<account-id>:configuration-set/mailcheap"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["ses:GetAccount", "ses:ListEmailIdentities", "ses:GetEmailIdentity"],
      "Resource": "*"
    }
  ]
}
```

9. **Add the variables to `.env`** and deploy again: `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_CONFIGURATION_SET` and `SES_SNS_TOPIC_ARN`.
10. **Subscribe Mailcheap to the topic.** In the SNS topic, **Create subscription** with protocol HTTPS and the `sesWebhookUrl` the deploy printed. Leave raw message delivery off. Mailcheap confirms the subscription by itself; refresh and the status turns to Confirmed.

The **Domains** page in Mailcheap now shows your domain with its DKIM and MAIL FROM status. Optional: in SES **Account dashboard > Suppression list**, turn on the account-level list for bounces and complaints too.

### 6. Turn sending on

1. In Mailcheap, create a newsletter. The from address must be on your verified domain, and the postal address shows in every email's footer (anti-spam laws require one).
2. Set `SENDING_ENABLED=true` and deploy again. On a staging stage, only send to your own test addresses.
3. Send yourself a test, then check delivery, the unsubscribe link, and a bounce (`bounce@simulator.amazonses.com`) on the campaign report and the Contacts page.
4. Write a campaign and send it. For a new domain, set a limit to reach your most engaged readers first, and use **Send to more** on the report once the first step looks healthy.

### Optional

- **Archive on its own domain:** route the domain to the app Worker (a custom domain or route on the Worker in the Cloudflare dashboard, or add it to `alchemy.run.ts`), then set `ARCHIVE_HOSTS=news.example.com=<newsletter-slug>` and deploy. That domain serves only the archive and the unsubscribe page, never the dashboard, and the app domain's `/archive/<newsletter-slug>` pages redirect there.

  This is the safer setup: issue pages show HTML from your editor and from API keys, and on their own domain that HTML never shares the dashboard's origin. Without one, the archive stays on the app domain, where the sanitizer, the sandboxed frame and the Content Security Policy protect it.
- **Alerts:** set `ALERT_FROM` (like `Mailcheap <alerts@mail.example.com>`) to get alerts by email at `ADMIN_EMAIL`: spam complaints, paused sends, unconfirmed sends, signup floods and rate limiter outages, plus every login, new API key and send. Otherwise they only show in the logs.
- **Deploy from GitHub:** `.github/workflows/deploy.yml` runs the same `npm run deploy` for a chosen stage. Add the secrets and variables it lists to a GitHub environment named after the stage.

## Operations and recovery

- **Logs:** both Workers have Workers Logs on; `npx alchemy logs --tail --stage prod` follows them. Look for `[jobs]`, `[cron]`, `[alert]` and `[ses-webhook]` lines.
- **Stop everything:** deploy with `SENDING_ENABLED=false`. Both Workers stop sending at once; queued messages stay queued and go out after you turn it back on.
- **Unconfirmed sends:** when SES doesn't answer a send (a timeout, a Worker that stopped mid-send), the message becomes `ambiguous` and is never resent automatically, because it may have gone out. An SES event for it later settles it. Never reset those messages to `queued` by hand.
- **Jobs:** every job is written to D1 (`job_outbox`) before it's published, and the minute cron publishes anything left behind and restarts stalled sends. Jobs that fail 8 times land in the `JobsDeadLetters` queue; their work stays in D1 and the cron picks the campaign up again.
- **Scheduled sends** start within about a minute of their time, subject to the queue backlog.
- **Backups:** D1 Time Travel can restore the database to any minute of the last 30 days (`npx wrangler d1 time-travel restore <database> --timestamp <time>`). Mailcheap also writes a daily snapshot of every table to the private backups bucket (`backups/<date>/`). To restore one into a new, empty database created by the same migrations: download the folder, then `node scripts/backup-to-sql.mjs ./<date> > restore.sql` and `npx wrangler d1 execute <database> --remote --file restore.sql`. Turn sending off first.
- **Rolling back code:** only to a version that works with the current schema. Migrations only add to the schema; never edit one that has been applied.
- **Lost deployment state:** the state lives in your Cloudflare account, not on your machine. Keep the logical IDs in `alchemy.run.ts` unchanged, or Alchemy will create new resources instead of reusing the old ones.

## Local development

- `npm run dev` runs everything locally (see Setup step 3). Restarting keeps the local data in `.alchemy/local`; delete that folder for a fresh database.
- Trigger the jobs Worker's cron by hand: open `/cdn-cgi/handler/scheduled?cron=*+*+*+*+*` on the jobs Worker's local URL.
- When the SES keys are empty, sends fail: a Worker has no `~/.aws` credentials.
- `npm test` runs the unit tests (D1 behavior runs against SQLite with the real migrations) and `npm run lint` runs ESLint. `npm run plan -- --stage staging` previews a deploy.

## Deliverability basics

- **Send from a subdomain** (`mail.example.com`), so a bad week doesn't affect your main domain's email.
- **Authenticate everything:** DKIM (Easy DKIM), SPF through the custom MAIL FROM domain, and DMARC on the root domain.
- **Only email people who asked.** Never import a bought or scraped list. If bots fill your forms, turn on confirmed opt-in.
- **Warm up a new domain.** Send to your most engaged readers first, and grow each send over a few weeks.
- **Watch complaints and bounces.** Keep complaints under 0.1% and bounces under 2%. Mailcheap pauses a send above 0.08% complaints or 2% bounces. Add your domain to [Google Postmaster Tools](https://postmaster.google.com) to see your spam rate at Gmail.
- **Make leaving easy.** Every email has one-click unsubscribe headers and a footer link, which Gmail and Yahoo require.
- **Clean your list.** Turn on list cleanup in each newsletter's settings to stop emailing people who never open.
- **Keep emails under 100 KB**, or Gmail clips them and hides the unsubscribe link.

## Environment variables

Set them in `.env` (or the shell, or CI) before `npm run dev` or `npm run deploy`. Cloudflare bindings (`DB`, `ASSETS_BUCKET`, `BACKUPS_BUCKET`, `JOBS_QUEUE`, `RATE_LIMITER`, `SES_PACER`) and `APP_URL` are set by the stack.

| Variable | Required | What it does |
| --- | --- | --- |
| `ADMIN_EMAIL` | Yes | Dashboard login, and where test emails and alerts go |
| `ADMIN_PASSWORD` | Yes | Dashboard password, 12+ characters. Changing it signs out every session. |
| `SESSION_SECRET` | Yes | Signs sessions and email links. 32+ random characters. Changing it breaks links in sent emails. |
| `APP_DOMAIN` | Before real sends | Dashboard and email-link domain on your Cloudflare account. Empty: workers.dev URL. |
| `ASSET_DOMAIN` | No | Domain for uploaded images on the R2 bucket. Empty: served by the app at `/media`. |
| `SENDING_ENABLED` | To send | Nothing is sent unless it's `true` |
| `SES_REGION` | To send | SES region, `us-east-1` by default |
| `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` | To send | IAM user keys |
| `SES_CONFIGURATION_SET` | To send | Configuration set that publishes events to SNS |
| `SES_SNS_TOPIC_ARN` | To send | SNS topic Mailcheap accepts at `/api/webhooks/ses` |
| `SEND_RATE_PER_SECOND` | No | Emails per second across every send, 1 to 14 (default 10) |
| `ARCHIVE_HOSTS` | No | Archive domains, like `news.example.com=weekly,letters.example.org=monthly` |
| `ALERT_FROM` | No | From address for alert emails, on a verified domain |

[`.env.example`](.env.example) has the same list with more detail.

## API

Create a key on the **API keys** page and send it as `Authorization: Bearer <key>`.

**Add a contact**: `POST /api/v1/contacts`

```bash
curl -X POST https://<your-app>/api/v1/contacts \
  -H "Authorization: Bearer $MAILCHEAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"newsletter":"weekly","email":"jane@example.com","source":"website","ip":"203.0.113.7"}'
```

- `newsletter` (slug) and `email` are required. `source` labels where the signup came from.
- `resubscribe: true` brings back someone who unsubscribed (never someone who bounced or complained).
- Pass your visitor's IP as `ip` to get the per-visitor limit of 5 signups per 10 minutes. Each key is also limited to 600 signups an hour.
- Answers `201` for a new contact, `200` if it already existed, with `{ id, status, created }`. When the newsletter confirms signups, `status` is `pending` and `inbox` links to the reader's email provider for your "check your inbox" message.

**Create a draft**: `POST /api/v1/campaigns` with `newsletter`, `subject`, `previewText` (optional), `html` or `markdown`, and `archiveSlug` (optional). Answers `201` with the draft's id and dashboard URL. Sending stays a click in the dashboard.

**List sent issues**: `GET /api/v1/campaigns?newsletter=<slug>` returns each issue's id, subject, preview text, archive URL and send date.

## How it works

- Next.js App Router API on [vinext](https://vinext.dev), JavaScript, Tailwind CSS with shadcn/ui, Cloudflare D1 through plain parameterized SQL (`lib/db.js`, schema in `migrations/`).
- **Send** picks the audience in bounded pages (active contacts, suppressions left out, most engaged first), creates one message per reader, and commits one job per batch of 50 to D1 together with the status change. The jobs Worker consumes them from a Cloudflare Queue, claims each message before calling the SES v2 API, paces every send through one Durable Object per SES region at `SEND_RATE_PER_SECOND`, and pauses the campaign if bounce or complaint rates pass the limits.
- Welcome and confirmation emails go out right away, through the same pacing, capped at 100 every 10 minutes per newsletter.
- A minute cron starts due scheduled campaigns, publishes jobs left in D1, marks abandoned sends as unconfirmed and restarts stalled campaigns.
- SES publishes events to SNS, which posts them to `/api/webhooks/ses`. Mailcheap verifies the SNS signature, stores the event in D1, answers, and the jobs Worker applies it: the message, the campaign stats and the contact (counted once by SQL triggers), and suppression of bounced and complaining addresses for every newsletter.
- Opens and clicks go through `/o/...` and `/c/...` on your app's domain. Clicks within 30 seconds of the send, or from known link scanners, don't count.
- Archive pages are cached (Alchemy provisions the KV cache) and refresh when you send or save.

## Support

There's none: issues are off and pull requests may not be reviewed. This is a one-time release, with no updates planned. See [SECURITY.md](SECURITY.md) for what's built in.

## License

[MIT](LICENSE). Made by [Marc Lou](https://x.com/marclou).
