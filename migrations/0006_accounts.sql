-- Accounts: every customer row belongs to one account (upstream's multi-account MailCheap).
-- The single-tenant tables of 0001-0005 were never deployed with data, so they are rebuilt rather than copied.
-- Dates in columns are UTC milliseconds; dates inside JSON columns are ISO strings, revived by lib/db.js.
DROP TRIGGER IF EXISTS messages_first_events;
DROP TRIGGER IF EXISTS contacts_insert_suppressed;
DROP TRIGGER IF EXISTS contacts_block_reactivation;
DROP TRIGGER IF EXISTS suppressions_preserve_precedence;
DROP TRIGGER IF EXISTS suppressions_insert_contacts;
DROP TRIGGER IF EXISTS suppressions_update_contacts;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS campaigns;
DROP TABLE IF EXISTS contacts;
DROP TABLE IF EXISTS newsletters;
DROP TABLE IF EXISTS suppressions;
DROP TABLE IF EXISTS api_keys;
DROP TABLE IF EXISTS alerts;
DROP TABLE IF EXISTS job_outbox;

CREATE TABLE accounts (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  -- The Better Auth user who signed up (users.id). One user per account.
  ownerId TEXT NOT NULL UNIQUE,
  plan TEXT,
  interval TEXT,
  stripeCustomerId TEXT,
  stripeSubscriptionId TEXT,
  subscriptionStatus TEXT,
  currentPeriodStart INTEGER,
  currentPeriodEnd INTEGER,
  cancelAt INTEGER,
  usage TEXT NOT NULL DEFAULT '{"emailsSent":0}' CHECK (json_valid(usage) AND json_type(usage) = 'object'),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  pausedAt INTEGER,
  pauseReason TEXT,
  pausedBy TEXT CHECK (pausedBy IS NULL OR pausedBy IN ('admin', 'rates', 'campaign', 'slice', 'trap', 'ses', 'postshiba')),
  ses TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(ses) AND json_type(ses) = 'object'),
  postshiba TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(postshiba) AND json_type(postshiba) = 'object'),
  health TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(health) AND json_type(health) = 'object'),
  spreadUntil INTEGER,
  onboarding TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(onboarding) AND json_type(onboarding) = 'object'),
  limitOverrides TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(limitOverrides) AND json_type(limitOverrides) = 'object'),
  comp TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(comp) AND json_type(comp) = 'object'),
  deletion TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(deletion) AND json_type(deletion) = 'object'),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX accounts_stripe_customer ON accounts(stripeCustomerId) WHERE stripeCustomerId IS NOT NULL;
CREATE INDEX accounts_stripe_subscription ON accounts(stripeSubscriptionId) WHERE stripeSubscriptionId IS NOT NULL;
CREATE INDEX accounts_created ON accounts(createdAt DESC);
CREATE UNIQUE INDEX accounts_ses_tenant ON accounts(json_extract(ses, '$.tenantName')) WHERE json_extract(ses, '$.tenantName') IS NOT NULL;
CREATE UNIQUE INDEX accounts_postshiba_tenant ON accounts(json_extract(postshiba, '$.tenantSlug')) WHERE json_extract(postshiba, '$.tenantSlug') IS NOT NULL;
CREATE INDEX accounts_purge ON accounts(json_extract(deletion, '$.purgeAt')) WHERE json_extract(deletion, '$.purgeAt') IS NOT NULL;

CREATE TABLE newsletters (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  accountId TEXT NOT NULL REFERENCES accounts(_id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) > 0 AND slug = lower(trim(slug))),
  imageUrl TEXT,
  fromName TEXT,
  fromEmail TEXT NOT NULL CHECK (length(fromEmail) > 0 AND fromEmail = lower(trim(fromEmail))),
  replyTo TEXT,
  postalAddress TEXT,
  archiveEnabled INTEGER NOT NULL DEFAULT 0 CHECK (archiveEnabled IN (0, 1)),
  archiveHost TEXT CHECK (archiveHost IS NULL OR archiveHost = lower(trim(archiveHost))),
  sharedSender TEXT CHECK (sharedSender IS NULL OR (json_valid(sharedSender) AND json_type(sharedSender) = 'object')),
  description TEXT,
  socialLinks TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(socialLinks) AND json_type(socialLinks) = 'array'),
  author TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(author) AND json_type(author) = 'object'),
  requireConfirmation INTEGER NOT NULL DEFAULT 0 CHECK (requireConfirmation IN (0, 1)),
  cleanup TEXT NOT NULL DEFAULT '{"enabled":false}' CHECK (
    json_valid(cleanup) AND json_type(cleanup) = 'object'
    AND (json_extract(cleanup, '$.issues') IS NULL OR json_extract(cleanup, '$.issues') >= 1)
    AND (json_extract(cleanup, '$.days') IS NULL OR json_extract(cleanup, '$.days') >= 1)
  ),
  welcome TEXT NOT NULL DEFAULT '{"enabled":false}' CHECK (json_valid(welcome) AND json_type(welcome) = 'object'),
  confirmation TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(confirmation) AND json_type(confirmation) = 'object'),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX newsletters_account ON newsletters(accountId, createdAt, _id);
CREATE UNIQUE INDEX newsletters_archive_host ON newsletters(archiveHost) WHERE archiveHost IS NOT NULL;
CREATE INDEX newsletters_shared_sender ON newsletters(json_extract(sharedSender, '$.domain')) WHERE sharedSender IS NOT NULL;

CREATE TABLE contact_imports (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  accountId TEXT NOT NULL REFERENCES accounts(_id) ON DELETE RESTRICT,
  newsletterId TEXT NOT NULL REFERENCES newsletters(_id) ON DELETE RESTRICT,
  userId TEXT,
  apiKeyId TEXT,
  source TEXT NOT NULL DEFAULT 'dashboard',
  consent INTEGER NOT NULL CHECK (consent IN (0, 1)),
  consentText TEXT NOT NULL,
  consentAt INTEGER NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  existing INTEGER NOT NULL DEFAULT 0,
  dropped TEXT NOT NULL DEFAULT '{"invalid":0,"typo":0,"trap":0,"role":0,"disposable":0,"duplicate":0,"suppressed":0,"noMail":0}'
    CHECK (json_valid(dropped) AND json_type(dropped) = 'object'),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX contact_imports_account ON contact_imports(accountId, createdAt DESC);

CREATE TABLE contacts (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  accountId TEXT NOT NULL REFERENCES accounts(_id) ON DELETE RESTRICT,
  newsletterId TEXT NOT NULL REFERENCES newsletters(_id) ON DELETE RESTRICT,
  email TEXT NOT NULL CHECK (length(email) > 0 AND email = lower(trim(email))),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'unsubscribed', 'bounced', 'complained', 'dormant')),
  source TEXT,
  importId TEXT REFERENCES contact_imports(_id) ON DELETE SET NULL,
  -- Added by hand on the dashboard: {userId, at}.
  consent TEXT CHECK (consent IS NULL OR (json_valid(consent) AND json_type(consent) = 'object')),
  subscribedAt INTEGER NOT NULL,
  confirmedAt INTEGER,
  unsubscribedAt INTEGER,
  lastSentAt INTEGER,
  lastOpenAt INTEGER,
  lastClickAt INTEGER,
  ignoredIssues INTEGER CHECK (ignoredIssues >= 0),
  lastEngagedAt INTEGER,
  lastChanceAt INTEGER,
  stats TEXT NOT NULL DEFAULT '{"sent":0,"opens":0,"clicks":0}' CHECK (json_valid(stats) AND json_type(stats) = 'object'),
  imported TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(imported) AND json_type(imported) = 'object'),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  UNIQUE (newsletterId, email)
);
CREATE INDEX contacts_account_email ON contacts(accountId, email);
CREATE INDEX contacts_account_subscribed ON contacts(accountId, subscribedAt DESC, _id DESC);
CREATE INDEX contacts_account_status_subscribed ON contacts(accountId, status, subscribedAt DESC, _id DESC);
CREATE INDEX contacts_newsletter_subscribed ON contacts(newsletterId, subscribedAt DESC, _id DESC);
CREATE INDEX contacts_newsletter_status_subscribed ON contacts(newsletterId, status, subscribedAt DESC, _id DESC);
CREATE INDEX contacts_newsletter_id ON contacts(newsletterId, _id);
CREATE INDEX contacts_cleanup ON contacts(newsletterId, lastChanceAt) WHERE lastChanceAt IS NOT NULL;
CREATE INDEX contacts_audience ON contacts(
  newsletterId, status, lastClickAt DESC, lastOpenAt DESC,
  json_extract(imported, '$.clickRate') DESC, json_extract(imported, '$.openRate') DESC,
  createdAt, _id
);

CREATE TABLE campaigns (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  accountId TEXT NOT NULL REFERENCES accounts(_id) ON DELETE RESTRICT,
  newsletterId TEXT NOT NULL REFERENCES newsletters(_id) ON DELETE RESTRICT,
  subject TEXT NOT NULL DEFAULT '',
  previewText TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'rich' CHECK (format IN ('markdown', 'html', 'rich')),
  markdown TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'sent', 'canceled')),
  pauseReason TEXT,
  pauseCode TEXT,
  ratesAcceptedAt INTEGER,
  audienceLimit INTEGER CHECK (audienceLimit >= 1),
  -- First send in steps (lib/first-send.js): {slice, held, checkAt, checkedAt}.
  firstSend TEXT CHECK (firstSend IS NULL OR (json_valid(firstSend) AND json_type(firstSend) = 'object')),
  source TEXT NOT NULL DEFAULT 'dashboard',
  scheduledAt INTEGER,
  startedAt INTEGER,
  sendingUntil INTEGER,
  spreadHours REAL,
  sentAt INTEGER,
  testSentAt INTEGER,
  archiveSlug TEXT UNIQUE CHECK (archiveSlug IS NULL OR (length(archiveSlug) > 0 AND archiveSlug = lower(trim(archiveSlug)))),
  thumbnailUrl TEXT,
  archiveListed INTEGER NOT NULL DEFAULT 1 CHECK (archiveListed IN (0, 1)),
  archivePinned INTEGER NOT NULL DEFAULT 0 CHECK (archivePinned IN (0, 1)),
  webViews INTEGER NOT NULL DEFAULT 0 CHECK (webViews >= 0),
  stats TEXT NOT NULL DEFAULT '{"recipients":0,"sent":0,"delivered":0,"bounced":0,"complained":0,"opened":0,"clicked":0,"unsubscribed":0,"failed":0}' CHECK (json_valid(stats) AND json_type(stats) = 'object'),
  lastChance TEXT NOT NULL DEFAULT '{"recipients":0,"sent":0,"delivered":0,"bounced":0,"complained":0,"failed":0,"dormant":0}' CHECK (json_valid(lastChance) AND json_type(lastChance) = 'object'),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX campaigns_newsletter_created ON campaigns(newsletterId, createdAt DESC);
CREATE INDEX campaigns_account_status ON campaigns(accountId, status);
CREATE INDEX campaigns_schedule ON campaigns(status, scheduledAt);
CREATE INDEX campaigns_newsletter_started ON campaigns(newsletterId, startedAt DESC);
CREATE INDEX campaigns_started ON campaigns(startedAt DESC);
CREATE INDEX campaigns_archive ON campaigns(newsletterId, status, sentAt DESC, startedAt DESC);
CREATE INDEX campaigns_first_send_check ON campaigns(json_extract(firstSend, '$.checkAt'))
  WHERE firstSend IS NOT NULL AND json_extract(firstSend, '$.checkedAt') IS NULL;

CREATE TABLE messages (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  accountId TEXT NOT NULL REFERENCES accounts(_id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('campaign', 'last-chance', 'welcome', 'confirmation', 'test')),
  campaignId TEXT REFERENCES campaigns(_id) ON DELETE RESTRICT,
  newsletterId TEXT NOT NULL REFERENCES newsletters(_id) ON DELETE RESTRICT,
  contactId TEXT REFERENCES contacts(_id) ON DELETE RESTRICT,
  email TEXT NOT NULL CHECK (length(email) > 0 AND email = lower(trim(email))),
  provider TEXT,
  -- held: a first send's contacts past its first slice. sending/ambiguous: claimed before the provider call,
  -- and a call that never answered (never resent; reconciled from provider events).
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('held', 'queued', 'sending', 'ambiguous', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed')),
  firstSend INTEGER CHECK (firstSend IS NULL OR firstSend IN (0, 1)),
  providerMessageId TEXT,
  error TEXT,
  claimedAt INTEGER,
  sentAt INTEGER,
  deliveredAt INTEGER,
  openedAt INTEGER,
  clickedAt INTEGER,
  bouncedAt INTEGER,
  complainedAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  CHECK (kind NOT IN ('campaign', 'last-chance') OR (campaignId IS NOT NULL AND contactId IS NOT NULL))
);
CREATE UNIQUE INDEX messages_campaign_contact ON messages(campaignId, contactId) WHERE kind = 'campaign';
CREATE UNIQUE INDEX messages_last_chance_contact ON messages(campaignId, contactId) WHERE kind = 'last-chance';
CREATE INDEX messages_provider_id ON messages(providerMessageId) WHERE providerMessageId IS NOT NULL;
CREATE INDEX messages_kind_created ON messages(kind, createdAt DESC);
CREATE INDEX messages_newsletter_sent ON messages(newsletterId, sentAt, _id);
CREATE INDEX messages_campaign_status ON messages(campaignId, status, kind, _id);
CREATE INDEX messages_contact_kind ON messages(contactId, kind, createdAt);
CREATE INDEX messages_claimed ON messages(status, claimedAt) WHERE status = 'sending';
CREATE INDEX messages_ambiguous ON messages(campaignId, updatedAt) WHERE status = 'ambiguous';
CREATE INDEX messages_account_queued ON messages(accountId, campaignId) WHERE status = 'queued';
CREATE INDEX messages_account_sent ON messages(accountId, sentAt DESC);
CREATE INDEX messages_account_email ON messages(accountId, email);

CREATE TABLE events (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  accountId TEXT NOT NULL REFERENCES accounts(_id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (length(type) > 0),
  providerMessageId TEXT,
  providerEventId TEXT,
  messageId TEXT REFERENCES messages(_id) ON DELETE RESTRICT,
  campaignId TEXT REFERENCES campaigns(_id) ON DELETE RESTRICT,
  email TEXT CHECK (email IS NULL OR email = lower(trim(email))),
  occurredAt INTEGER NOT NULL,
  data TEXT CHECK (data IS NULL OR json_valid(data)),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX events_provider_message ON events(providerMessageId);
CREATE UNIQUE INDEX events_provider_event ON events(providerEventId) WHERE providerEventId IS NOT NULL;
CREATE INDEX events_campaign_type ON events(campaignId, type);
CREATE INDEX events_account_occurred ON events(accountId, occurredAt DESC);

-- Per account: an address that bounced or complained is never emailed again from any of its newsletters.
CREATE TABLE suppressions (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  accountId TEXT NOT NULL REFERENCES accounts(_id) ON DELETE RESTRICT,
  email TEXT NOT NULL CHECK (length(email) > 0 AND email = lower(trim(email))),
  reason TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint', 'manual', 'provider')),
  detail TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  UNIQUE (accountId, email)
);
CREATE INDEX suppressions_account_created ON suppressions(accountId, createdAt DESC);

CREATE TABLE api_keys (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  accountId TEXT NOT NULL REFERENCES accounts(_id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  prefix TEXT NOT NULL CHECK (length(prefix) > 0),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) > 0),
  level TEXT CHECK (level IS NULL OR level IN ('full', 'signups')),
  lastUsedAt INTEGER,
  revokedAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX api_keys_account ON api_keys(accountId, createdAt DESC);

-- One row per alert kind and account; platform alerts have no account.
CREATE TABLE alerts (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  accountId TEXT REFERENCES accounts(_id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (length(key) > 0),
  title TEXT,
  lastSentAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX alerts_account_key ON alerts(coalesce(accountId, ''), key);

-- A customer's own sending domain. Unique across accounts: it belongs to the first account that adds it.
CREATE TABLE domains (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  accountId TEXT NOT NULL REFERENCES accounts(_id) ON DELETE RESTRICT,
  domain TEXT NOT NULL UNIQUE CHECK (length(domain) > 0 AND domain = lower(trim(domain))),
  mailFromDomain TEXT NOT NULL CHECK (mailFromDomain = lower(trim(mailFromDomain))),
  archiveHost TEXT NOT NULL UNIQUE CHECK (archiveHost = lower(trim(archiveHost))),
  provider TEXT,
  providerDomainId TEXT,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1)),
  dkimStatus TEXT NOT NULL DEFAULT 'PENDING',
  mailFromStatus TEXT NOT NULL DEFAULT 'PENDING',
  archiveHostVerified INTEGER NOT NULL DEFAULT 0 CHECK (archiveHostVerified IN (0, 1)),
  records TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(records) AND json_type(records) = 'array'),
  checkedAt INTEGER,
  verifiedAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX domains_account ON domains(accountId, createdAt);

-- Uploaded images in R2. Sent emails point at the URL forever, so the object is never moved.
CREATE TABLE uploads (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  accountId TEXT NOT NULL REFERENCES accounts(_id) ON DELETE RESTRICT,
  url TEXT NOT NULL,
  pathname TEXT NOT NULL,
  contentType TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX uploads_account ON uploads(accountId, createdAt DESC);

-- What stays of a deleted account: its owner's email as a keyed hash, and the dates.
CREATE TABLE deletion_records (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  accountId TEXT NOT NULL UNIQUE,
  emailHash TEXT NOT NULL,
  accountCreatedAt INTEGER,
  requestedAt INTEGER NOT NULL,
  purgedAt INTEGER
);
CREATE INDEX deletion_records_email ON deletion_records(emailHash);

-- The intent is committed with application state; a successful Queue publish marks it published.
-- A crash between publish and marking can redeliver, so consumers must claim their work atomically.
CREATE TABLE job_outbox (
  _id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (length(kind) > 0),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  availableAt INTEGER NOT NULL,
  publishedAt INTEGER,
  completedAt INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lastError TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX job_outbox_pending ON job_outbox(availableAt, _id) WHERE publishedAt IS NULL;
CREATE INDEX job_outbox_completed ON job_outbox(completedAt) WHERE completedAt IS NOT NULL;

-- First-event timestamps and their counters commit in the same SQLite statement.
-- Callers update messages; they must not increment these counters separately.
CREATE TRIGGER messages_first_events
AFTER UPDATE OF sentAt, deliveredAt, openedAt, clickedAt, bouncedAt, complainedAt, status ON messages
WHEN (OLD.sentAt IS NULL AND NEW.sentAt IS NOT NULL)
  OR (OLD.deliveredAt IS NULL AND NEW.deliveredAt IS NOT NULL)
  OR (OLD.openedAt IS NULL AND NEW.openedAt IS NOT NULL)
  OR (OLD.clickedAt IS NULL AND NEW.clickedAt IS NOT NULL)
  OR (OLD.bouncedAt IS NULL AND NEW.bouncedAt IS NOT NULL)
  OR (OLD.complainedAt IS NULL AND NEW.complainedAt IS NOT NULL)
  OR (OLD.status != 'failed' AND NEW.status = 'failed')
BEGIN
  UPDATE campaigns SET
    stats = json_set(stats,
      '$.sent', coalesce(json_extract(stats, '$.sent'), 0) + (OLD.sentAt IS NULL AND NEW.sentAt IS NOT NULL),
      '$.delivered', coalesce(json_extract(stats, '$.delivered'), 0) + (OLD.deliveredAt IS NULL AND NEW.deliveredAt IS NOT NULL),
      '$.opened', coalesce(json_extract(stats, '$.opened'), 0) + (OLD.openedAt IS NULL AND NEW.openedAt IS NOT NULL),
      '$.clicked', coalesce(json_extract(stats, '$.clicked'), 0) + (OLD.clickedAt IS NULL AND NEW.clickedAt IS NOT NULL),
      '$.bounced', coalesce(json_extract(stats, '$.bounced'), 0) + (OLD.bouncedAt IS NULL AND NEW.bouncedAt IS NOT NULL),
      '$.complained', coalesce(json_extract(stats, '$.complained'), 0) + (OLD.complainedAt IS NULL AND NEW.complainedAt IS NOT NULL),
      '$.failed', coalesce(json_extract(stats, '$.failed'), 0) + (OLD.status != 'failed' AND NEW.status = 'failed')
    ),
    updatedAt = max(updatedAt, NEW.updatedAt)
  WHERE _id = NEW.campaignId AND NEW.kind = 'campaign';

  UPDATE campaigns SET
    lastChance = json_set(lastChance,
      '$.sent', coalesce(json_extract(lastChance, '$.sent'), 0) + (OLD.sentAt IS NULL AND NEW.sentAt IS NOT NULL),
      '$.delivered', coalesce(json_extract(lastChance, '$.delivered'), 0) + (OLD.deliveredAt IS NULL AND NEW.deliveredAt IS NOT NULL),
      '$.bounced', coalesce(json_extract(lastChance, '$.bounced'), 0) + (OLD.bouncedAt IS NULL AND NEW.bouncedAt IS NOT NULL),
      '$.complained', coalesce(json_extract(lastChance, '$.complained'), 0) + (OLD.complainedAt IS NULL AND NEW.complainedAt IS NOT NULL),
      '$.failed', coalesce(json_extract(lastChance, '$.failed'), 0) + (OLD.status != 'failed' AND NEW.status = 'failed')
    ),
    updatedAt = max(updatedAt, NEW.updatedAt)
  WHERE _id = NEW.campaignId AND NEW.kind = 'last-chance';

  UPDATE contacts SET
    stats = json_set(stats,
      '$.sent', coalesce(json_extract(stats, '$.sent'), 0) + (OLD.sentAt IS NULL AND NEW.sentAt IS NOT NULL),
      '$.opens', coalesce(json_extract(stats, '$.opens'), 0) + (OLD.openedAt IS NULL AND NEW.openedAt IS NOT NULL),
      '$.clicks', coalesce(json_extract(stats, '$.clicks'), 0) + (OLD.clickedAt IS NULL AND NEW.clickedAt IS NOT NULL)
    ),
    lastSentAt = nullif(max(coalesce(lastSentAt, 0), coalesce(NEW.sentAt, 0)), 0),
    lastOpenAt = nullif(max(coalesce(lastOpenAt, 0), coalesce(NEW.openedAt, 0)), 0),
    lastClickAt = nullif(max(coalesce(lastClickAt, 0), coalesce(NEW.clickedAt, 0)), 0),
    lastEngagedAt = nullif(max(coalesce(lastEngagedAt, 0), coalesce(NEW.openedAt, 0), coalesce(NEW.clickedAt, 0)), 0),
    lastChanceAt = CASE WHEN NEW.kind = 'last-chance' AND NEW.sentAt IS NOT NULL
      THEN max(coalesce(lastChanceAt, 0), NEW.sentAt) ELSE lastChanceAt END,
    ignoredIssues = CASE
      WHEN (OLD.openedAt IS NULL AND NEW.openedAt IS NOT NULL)
        OR (OLD.clickedAt IS NULL AND NEW.clickedAt IS NOT NULL) THEN 0
      WHEN NEW.kind = 'campaign' AND OLD.sentAt IS NULL AND NEW.sentAt IS NOT NULL
        AND coalesce(lastEngagedAt, 0) < NEW.sentAt THEN coalesce(ignoredIssues, 0) + 1
      ELSE ignoredIssues END,
    updatedAt = max(updatedAt, NEW.updatedAt)
  WHERE _id = NEW.contactId AND NEW.kind != 'test';
END;

-- A concurrent signup/import cannot reactivate an address the account suppressed.
-- An imported bounce/complaint also outranks an existing manual suppression.
-- A 'provider' suppression (the email provider refused the address) leaves contacts as they are, as upstream does:
-- sends skip every suppressed address, whatever its contacts' status.
CREATE TRIGGER contacts_insert_suppressed
AFTER INSERT ON contacts
WHEN EXISTS (SELECT 1 FROM suppressions WHERE accountId = NEW.accountId AND email = NEW.email AND reason != 'provider')
BEGIN
  UPDATE contacts SET status = CASE
    WHEN NEW.status = 'complained' OR (SELECT reason FROM suppressions WHERE accountId = NEW.accountId AND email = NEW.email) = 'complaint' THEN 'complained'
    WHEN NEW.status = 'bounced' OR (SELECT reason FROM suppressions WHERE accountId = NEW.accountId AND email = NEW.email) = 'bounce' THEN 'bounced'
    ELSE 'unsubscribed' END
  WHERE _id = NEW._id;
END;

CREATE TRIGGER contacts_block_reactivation
BEFORE UPDATE OF status ON contacts
WHEN (OLD.status = 'complained' AND NEW.status != 'complained')
  OR (OLD.status = 'bounced' AND NEW.status NOT IN ('bounced', 'complained'))
  OR (NEW.status IN ('active', 'pending', 'dormant') AND EXISTS (SELECT 1 FROM suppressions WHERE accountId = NEW.accountId AND email = NEW.email AND reason != 'provider'))
BEGIN
  SELECT RAISE(ABORT, 'suppressed contacts cannot be reactivated');
END;

CREATE TRIGGER suppressions_preserve_precedence
BEFORE UPDATE OF reason ON suppressions
WHEN (OLD.reason = 'complaint' AND NEW.reason != 'complaint')
  OR (OLD.reason = 'bounce' AND NEW.reason IN ('manual', 'provider'))
BEGIN
  SELECT RAISE(ABORT, 'suppression cannot be weakened');
END;

CREATE TRIGGER suppressions_insert_contacts
AFTER INSERT ON suppressions
WHEN NEW.reason != 'provider'
BEGIN
  UPDATE contacts SET status = CASE NEW.reason
    WHEN 'complaint' THEN 'complained' WHEN 'bounce' THEN 'bounced' ELSE 'unsubscribed' END,
    updatedAt = max(updatedAt, NEW.updatedAt)
  WHERE accountId = NEW.accountId AND email = NEW.email AND status != 'complained'
    AND (status != 'bounced' OR NEW.reason = 'complaint');
END;

CREATE TRIGGER suppressions_update_contacts
AFTER UPDATE OF reason ON suppressions
WHEN NEW.reason != 'provider'
BEGIN
  UPDATE contacts SET status = CASE NEW.reason
    WHEN 'complaint' THEN 'complained' WHEN 'bounce' THEN 'bounced' ELSE 'unsubscribed' END,
    updatedAt = max(updatedAt, NEW.updatedAt)
  WHERE accountId = NEW.accountId AND email = NEW.email AND status != 'complained'
    AND (status != 'bounced' OR NEW.reason = 'complaint');
END;

-- Secrets kept out of the accounts row, so no SELECT * of an account ever carries them (upstream's select: false).
-- postshibaPassword is AES-256-GCM encrypted (lib/credentials.js).
CREATE TABLE account_secrets (
  accountId TEXT PRIMARY KEY NOT NULL REFERENCES accounts(_id) ON DELETE CASCADE,
  postshibaPassword TEXT,
  updatedAt INTEGER NOT NULL
);
