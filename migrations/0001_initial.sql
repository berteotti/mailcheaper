-- Dates are UTC milliseconds. IDs retain the application's 24-character hex format.
-- There are no destructive deletes in the app; references deliberately restrict deletion.
CREATE TABLE newsletters (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  slug TEXT NOT NULL UNIQUE CHECK (length(slug) > 0 AND slug = lower(trim(slug))),
  imageUrl TEXT,
  fromName TEXT,
  fromEmail TEXT NOT NULL CHECK (length(fromEmail) > 0 AND fromEmail = lower(trim(fromEmail))),
  replyTo TEXT,
  postalAddress TEXT,
  archiveEnabled INTEGER NOT NULL DEFAULT 0 CHECK (archiveEnabled IN (0, 1)),
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

CREATE TABLE contacts (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  newsletterId TEXT NOT NULL REFERENCES newsletters(_id) ON DELETE RESTRICT,
  email TEXT NOT NULL CHECK (length(email) > 0 AND email = lower(trim(email))),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'unsubscribed', 'bounced', 'complained', 'dormant')),
  source TEXT,
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
CREATE INDEX contacts_email ON contacts(email);
CREATE INDEX contacts_subscribed ON contacts(subscribedAt DESC, _id DESC);
CREATE INDEX contacts_status_subscribed ON contacts(status, subscribedAt DESC, _id DESC);
CREATE INDEX contacts_newsletter_subscribed ON contacts(newsletterId, subscribedAt DESC, _id DESC);
CREATE INDEX contacts_newsletter_status_subscribed ON contacts(newsletterId, status, subscribedAt DESC, _id DESC);
CREATE INDEX contacts_cleanup ON contacts(newsletterId, lastChanceAt) WHERE lastChanceAt IS NOT NULL;
CREATE INDEX contacts_audience ON contacts(
  newsletterId, status, lastClickAt DESC, lastOpenAt DESC,
  json_extract(imported, '$.clickRate') DESC, json_extract(imported, '$.openRate') DESC,
  createdAt, _id
);

CREATE TABLE campaigns (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  newsletterId TEXT NOT NULL REFERENCES newsletters(_id) ON DELETE RESTRICT,
  subject TEXT NOT NULL DEFAULT '',
  previewText TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'rich' CHECK (format IN ('markdown', 'html', 'rich')),
  markdown TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sending', 'paused', 'sent', 'canceled')),
  audienceLimit INTEGER CHECK (audienceLimit >= 1),
  source TEXT NOT NULL DEFAULT 'dashboard',
  scheduledAt INTEGER,
  startedAt INTEGER,
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
CREATE INDEX campaigns_schedule ON campaigns(status, scheduledAt);
CREATE INDEX campaigns_started ON campaigns(startedAt DESC);
CREATE INDEX campaigns_archive ON campaigns(newsletterId, status, sentAt DESC, startedAt DESC);

CREATE TABLE messages (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('campaign', 'last-chance', 'welcome', 'confirmation', 'test')),
  campaignId TEXT REFERENCES campaigns(_id) ON DELETE RESTRICT,
  newsletterId TEXT NOT NULL REFERENCES newsletters(_id) ON DELETE RESTRICT,
  contactId TEXT REFERENCES contacts(_id) ON DELETE RESTRICT,
  email TEXT NOT NULL CHECK (length(email) > 0 AND email = lower(trim(email))),
  provider TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sending', 'ambiguous', 'sent', 'delivered', 'bounced', 'complained', 'failed', 'suppressed')),
  sesMessageId TEXT,
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
CREATE INDEX messages_ses_id ON messages(sesMessageId) WHERE sesMessageId IS NOT NULL;
CREATE INDEX messages_kind_created ON messages(kind, createdAt DESC);
CREATE INDEX messages_newsletter_sent ON messages(newsletterId, sentAt);
CREATE INDEX messages_campaign_status ON messages(campaignId, status, kind, _id);
CREATE INDEX messages_contact_kind ON messages(contactId, kind, createdAt);
CREATE INDEX messages_claimed ON messages(status, claimedAt) WHERE status = 'sending';

CREATE TABLE events (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  type TEXT NOT NULL CHECK (length(type) > 0),
  sesMessageId TEXT,
  messageId TEXT REFERENCES messages(_id) ON DELETE RESTRICT,
  campaignId TEXT REFERENCES campaigns(_id) ON DELETE RESTRICT,
  email TEXT CHECK (email IS NULL OR email = lower(trim(email))),
  occurredAt INTEGER NOT NULL,
  data TEXT CHECK (data IS NULL OR json_valid(data)),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX events_ses_id ON events(sesMessageId);
CREATE INDEX events_campaign_type ON events(campaignId, type);

CREATE TABLE suppressions (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  email TEXT NOT NULL UNIQUE CHECK (length(email) > 0 AND email = lower(trim(email))),
  reason TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint', 'manual')),
  detail TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX suppressions_created ON suppressions(createdAt);

CREATE TABLE api_keys (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  prefix TEXT NOT NULL CHECK (length(prefix) > 0),
  hash TEXT NOT NULL UNIQUE CHECK (length(hash) > 0),
  lastUsedAt INTEGER,
  revokedAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE alerts (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  key TEXT NOT NULL UNIQUE CHECK (length(key) > 0),
  title TEXT,
  lastSentAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

-- The intent is committed with application state; a successful Queue publish marks it published.
-- A crash between publish and marking can redeliver, so consumers must claim their work atomically.
CREATE TABLE job_outbox (
  _id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('prepare', 'send', 'scheduled', 'ses-event')),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  availableAt INTEGER NOT NULL,
  publishedAt INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lastError TEXT,
  createdAt INTEGER NOT NULL
);
CREATE INDEX job_outbox_pending ON job_outbox(availableAt, _id) WHERE publishedAt IS NULL;
