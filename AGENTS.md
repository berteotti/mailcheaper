<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# MailCheap

Read this before working on MailCheap. If `AGENTS.cloud.md` is next to it (MailCheap Cloud's own repository), read that too.

## What it is

MailCheap is a newsletter app: write an issue, send it to your list, publish it on the web. Everything the dashboard does also works from an AI agent, through a REST API and an MCP server.

It's open source under the AGPL-3.0 (`LICENSE`): anyone can run it on their own Cloudflare account with their own Amazon SES or PostShiba account, change it and share it. The README is the self-hosting guide. MailCheap Cloud ([mailcheap.ai](https://mailcheap.ai)) runs this same code for people who'd rather not host it.

## How it's organized

Next.js App Router in JavaScript, built with vinext (Vite) and run on Cloudflare Workers, Tailwind CSS with shadcn/ui, Cloudflare D1 for data, Better Auth for sign-in. `alchemy.run.ts` provisions and deploys all of it: the app Worker (vinext, its entry in `worker/index.ts`), the jobs Worker, D1, the Queue, the R2 buckets and the Durable Objects.

- **Dashboard**: `app/(app)` (overview, campaigns, contacts, newsletters, domains, API keys), `app/(account)` (account, billing), `app/admin`, the sign-in at `app/signin` and the newsletter setup at `app/welcome`.
- **Public pages**: the docs in `app/(site)`, each newsletter's archive in `app/archive`, and what emails link to (`app/unsubscribe`, `app/confirm`, `app/keep`, tracking in `app/o` and `app/c`). `proxy.js` routes newsletters' own hosts to their archive and only checks that a session cookie is there.
- **Actions**: every customer action is one `defineAction` in `lib/actions/<group>.js` (schemas, permission, handler). `runAction` is the only way to run one: from the dashboard's server actions, the REST API (`app/api/v1`) and MCP (`/mcp`, `lib/mcp/server.js`). The docs, the OpenAPI document and the llms files are generated from the same schemas, and `tests/parity.test.mjs` fails when an action is missing from any of them.
- **Accounts**: customer rows carry an `accountId`, and every query on them names it in its SQL: `accountIdOf(account)` (`lib/db.js`) takes an account, its id or a row that carries one, and throws without one. Nothing adds it for you, so `tests/isolation.test.mjs` tries to reach one account's data from another every way the app offers. `requireAccount()` for pages and server actions, `authenticateRequest()` for the API and MCP (`lib/auth.js`, `lib/api-keys.js`).
- **Organizations**: an account belongs to an organization, and people sign in to it as its owners or members (`lib/organizations.js`): one organization per person, opened at their first sign-in unless an invitation waits (`app/invitations`). `requireAccount()` gives the user, their membership, the organization and its account. Owners manage people, billing (`ownerOnly` actions) and deletion on `app/(account)/organization`; an API key acts for the whole organization, a connected app for the person who connected it.
- **MCP and OAuth**: API keys, or OAuth access tokens from Better Auth's OAuth provider (`lib/auth.js`, `lib/oauth.js`, `lib/oauth-rules.js`), with the consent page at `app/oauth/consent`.
- **Jobs**: a job goes into D1's `job_outbox` in the same transaction as the change it follows (`commitJobs` in `lib/jobs.js`), and its id onto the Queue. The jobs Worker (`worker/jobs.js`) runs it: sending batches, scheduled sends, first-send checks, the SES and PostShiba events their webhooks store, and the purge of deleted accounts. Its minute cron starts due campaigns, publishes what the outbox still holds, recovers stalled sends and prunes finished jobs; a daily one backs D1 up to R2 (`lib/backup.js`).
- **Email providers**: `lib/email-provider` switches between `ses.js` and `postshiba.js` (tenants, domains, sends), and their events become one shape (`lib/email-event-rules.js`). MailCheap's own emails (sign-in codes, alerts) go through `lib/platform-email.js`: Resend, Cloudflare Email Service, or the provider.
- **Storage**: the schema in `migrations/*.sql`, queries through `lib/db.js` and updates and inserts through `lib/records.js`. Images in the R2 asset bucket (`lib/assets.js`, `lib/image-storage.js`), served from the asset domain or by the app at `app/media`. Rate limits in the `RateLimiter` Durable Object, or in memory when it's unavailable (`lib/rate-limit.js`), and send pacing in `SesPacer` (`lib/send-rate.js`): both in `worker/durable-objects.js`, hosted by the app Worker.

## MailCheap Cloud and self-hosting

`isCloud()` in `lib/config.js` is `MAILCHEAP_CLOUD === "true"`, what mailcheap.ai runs with: open sign-up, plans and Stripe billing. Anything else is a self-hosted server: only the allowlist (`ADMIN_EMAILS`, `ALLOWED_EMAILS`) signs in, there's no billing and no limits. Both run from the same files, so a change has to work in both modes.

MailCheap Cloud's marketing site and analytics aren't part of the open source. Shared code reaches them only through the site extensions, `lib/site-extensions.js` and `components/SiteExtensions.jsx`, whose defaults add nothing: never import cloud-only code anywhere else.

## Rules

- The code is public: never commit secrets, keys, tokens or personal data (emails, phone numbers, addresses, customers' data), in code, tests, fixtures or commit messages. Tests use `example.com` and made-up values.
- Write "MailCheap" in display text: copy, titles, emails, docs, comments. Lowercase in identifiers and machine names: `mailcheap.ai`, `MAILCHEAP_CLOUD`, `LogoMailcheap`, package and file names.
- Copy is plain and short, in sentence case: only the first word of a title or a button is capitalized.

## Code style

- JavaScript, no TypeScript, apart from the two files Alchemy expects by name: `alchemy.run.ts` and `worker/index.ts`. Tabs. Don't run Prettier: it reformats whole files.
- Components in `components/`, in PascalCase and named by their kind first (`ButtonCopy.jsx`, `CardUsage.jsx`); other files in kebab-case. Server components by default, `"use client"` only where the browser is needed.
- Comments only for what the code can't show: a constraint, a reason, an outside rule. Not what the next line does.
- Read the code around a change and write like it.

## Tests

```bash
npm test       # node --test, the integration tests run on an in-memory SQLite with the migrations, in place of D1: nothing to install
npm run lint
npm run check:cloudflare
```

Tests import server actions and route handlers as they are; `tests/setup` resolves `cloudflare:workers` to the bindings in `tests/helpers` (D1, R2, the Queue) and stubs Next.js request APIs and every outside service, so nothing reaches the network. A change to behavior comes with its test, and the full suite and lint pass before it's pushed.
