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

-- A concurrent signup/import cannot reactivate a globally suppressed address.
CREATE TRIGGER contacts_insert_suppressed
AFTER INSERT ON contacts
WHEN EXISTS (SELECT 1 FROM suppressions WHERE email = NEW.email)
BEGIN
  UPDATE contacts SET status = CASE (SELECT reason FROM suppressions WHERE email = NEW.email)
    WHEN 'complaint' THEN 'complained' WHEN 'bounce' THEN 'bounced' ELSE 'unsubscribed' END
  WHERE _id = NEW._id;
END;

CREATE TRIGGER contacts_block_reactivation
BEFORE UPDATE OF status ON contacts
WHEN (OLD.status = 'complained' AND NEW.status != 'complained')
  OR (OLD.status = 'bounced' AND NEW.status NOT IN ('bounced', 'complained'))
  OR (NEW.status IN ('active', 'pending', 'dormant') AND EXISTS (SELECT 1 FROM suppressions WHERE email = NEW.email))
BEGIN
  SELECT RAISE(ABORT, 'suppressed contacts cannot be reactivated');
END;

CREATE TRIGGER suppressions_preserve_precedence
BEFORE UPDATE OF reason ON suppressions
WHEN (OLD.reason = 'complaint' AND NEW.reason != 'complaint')
  OR (OLD.reason = 'bounce' AND NEW.reason = 'manual')
BEGIN
  SELECT RAISE(ABORT, 'suppression cannot be weakened');
END;

CREATE TRIGGER suppressions_insert_contacts
AFTER INSERT ON suppressions
BEGIN
  UPDATE contacts SET status = CASE NEW.reason
    WHEN 'complaint' THEN 'complained' WHEN 'bounce' THEN 'bounced' ELSE 'unsubscribed' END,
    updatedAt = max(updatedAt, NEW.updatedAt)
  WHERE email = NEW.email AND status != 'complained'
    AND (status != 'bounced' OR NEW.reason = 'complaint');
END;

CREATE TRIGGER suppressions_update_contacts
AFTER UPDATE OF reason ON suppressions
BEGIN
  UPDATE contacts SET status = CASE NEW.reason
    WHEN 'complaint' THEN 'complained' WHEN 'bounce' THEN 'bounced' ELSE 'unsubscribed' END,
    updatedAt = max(updatedAt, NEW.updatedAt)
  WHERE email = NEW.email AND status != 'complained'
    AND (status != 'bounced' OR NEW.reason = 'complaint');
END;
