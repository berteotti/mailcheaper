# Cloudflare migration goals

Source: [migration plan](cloudflare-migration-plan.md). Scope: fresh installs;
retain Amazon SES/SNS and existing application behavior. Sending stays disabled
until staging feedback and safety checks pass.

- [x] **1. Prove the runtime and provision through Alchemy.** Restore locked
  dependencies, read installed Next.js guides, run the vinext compatibility
  pilot, pin the selected toolchain, define both Workers and stage-isolated
  resources with remote state, and verify auth/routing/actions/cache/share cards.
  *Verified on the local stage; the deployed-staging check is part of goal 6.*
- [x] **2. Replace MongoDB with D1.** Add ordered schema migrations and explicit
  parameterized queries across all model callers. Preserve IDs, constraints,
  suppression precedence, atomic counters, pagination, imports and timezones.
- [x] **3. Replace QStash/Redis with Queues/Cron/Durable Objects.** Add a durable
  outbox, bounded retry-safe consumers, schedule recovery, shared SES pacing,
  request limits and ambiguous-send reconciliation. Remove public job routes.
- [x] **4. Move assets and operational dependencies.** Use R2 with owned asset
  domains, bundle share-card assets, remove Google/Gravatar decoration, queue
  verified SNS events, preserve security and add logs/private backups.
- [x] **5. Make fresh setup reproducible.** Update setup/security/env/CI docs,
  remove unused provider packages and credentials, and document recovery.
- [ ] **6. Verify the complete migration.** Run unit/lint/build and local binding
  checks; verify staging flows, deploy twice without data loss, restore synthetic
  backups and rehearse a separate fresh stage.
  *Done locally (below). Pending: deploys to a real Cloudflare account and SES/SNS.*

## Selected toolchain (pinned in package.json / package-lock.json)

Node.js 24.11.1+ (`.nvmrc`; tested on 25.3.0), Next.js API 16.3.8 through vinext 1.2.0
(Vite 8.0.7, @vitejs/plugin-rsc 0.5.37), Alchemy 2.0.0-beta.83 with
`@alchemy.run/frontend-frameworks` 2.0.0-beta.83 and Effect 4.0.4. Compatibility date
2026-10-09 (`nodejs_compat` is a default from 2026-08-04). OpenNext was not needed.

## Architecture as built

- **App Worker** (`Cloudflare.Website.Vinext`, `worker/app.js`): dashboard, APIs, archive,
  tracking, SES webhook, `/media` image fallback. Hosts the `RateLimiter` and `SesPacer`
  Durable Objects (`worker/durable-objects.js`). Bindings: D1, R2 assets, jobs queue (producer).
- **Jobs Worker** (`Cloudflare.Worker`, `worker/jobs.js`, no public URL): queue consumer
  (batch 5, concurrency 4, 8 retries, dead-letter queue), minute cron (due schedules,
  outbox publication, stalled-send recovery, pruning) and daily backup cron. Binds the
  app's `SesPacer` across scripts and the app itself (service binding) to refresh caches.
- **D1**: migrations 0001–0005. `job_outbox` holds every job; Queue messages carry only its
  id, so SES events larger than a Queue message still fit.
- **R2**: `Assets` (public through `ASSET_DOMAIN` or the app's `/media`) and private
  `Backups`. D1 and both buckets are retained on removal in `prod`.
- **Sends**: atomic `queued → sending` claim before SES; SDK retries off; no answer from SES →
  `ambiguous` (never resent; reconciled by later SES events via the `message_id` tag);
  throttling → re-queued and deferred through the outbox; last-chance batches deferred until
  the issue has reached everyone; send order follows audience order.
- **Removed**: Mongoose models, QStash routes/signature wrapper, Upstash Redis/ratelimit,
  Vercel Blob, Vercel URL fallbacks, forwarded-for IP trust.

## Verification record (14 October 2026)

- `npm test`: 233 tests pass on Node 25.3.0 (D1 behavior against SQLite with the real
  migrations: outbox publication and recovery, at-least-once redelivery, ambiguous sends
  and their reconciliation, throttling deferral, stale claims, last-chance ordering,
  send-to-more, send-time suppression, schedule versions, SES precedence, engagement,
  audience keyset paging vs. the in-memory order, backup → restore round trip).
  `npm run lint`: clean. `alchemy.run.ts` type-checks.
- `alchemy dev --stage local` (workerd): login Server Action and session proxy, D1 empty
  states, newsletter create/save, archive cache refresh, archive signup through the
  rate-limit Durable Object, R2 upload and `/media` delivery, PNG share card with bundled
  fonts, security headers, internal route rejecting unsigned calls, cron → outbox → Queue →
  consumer, and a full scheduled campaign against a local mock SES: 5 sends paced at 10/s
  through the cross-script `SesPacer`, counters updated once, campaign settled. Stalled-send
  recovery republished the campaign after a deliberately broken first attempt, and that
  attempt's unconfirmed sends were not resent.
- Redeploying the local stage applied only new migrations (0003–0005) and kept data.
- Synthetic sizing: 5,000 contacts + 96,000 messages (one year at 8,000/month) + 20 issues
  ≈ 71 MB in D1, under 1% of the 10 GB cap per year: no retention changes needed.
  Each send costs about 3–4 D1 queries plus one Durable Object call.
- Not verified yet: real Cloudflare deploys (staging, deploy twice, fresh second stage),
  custom domains, R2 restore from a deployed bucket, SNS signature/subscription end to end,
  real SES sends and feedback, Workers Logs, production `vite build` output size.

## Remaining steps (need a Cloudflare account and AWS)

1. `npm run deploy -- --stage staging` with `SENDING_ENABLED=false` (also bootstraps
   Alchemy's state store in the account), smoke-test the printed URL.
2. Configure SES/SNS for staging, subscribe the printed `sesWebhookUrl`, enable sending for
   test recipients only, verify delivery, unsubscribe, bounce (`bounce@simulator.amazonses.com`)
   and complaint (`complaint@simulator.amazonses.com`) handling.
3. Deploy staging again and confirm data, assets and migrations are untouched.
4. Download a backup snapshot, restore it into a scratch D1 database, compare row counts.
5. Deploy an independent stage (e.g. `--stage rehearsal`) from a clean checkout with its own
   secrets, then `npm run destroy -- --stage rehearsal`.
