-- The reader unsubscribed through this email: the latest issue they got, for an unsubscribe link or their mail app's
-- button, or the email the provider's own unsubscribe names. Once per email.
ALTER TABLE messages ADD COLUMN unsubscribedAt INTEGER;

-- When the send started counting clicks per link (events of type link_click, lib/link-stats.js). Counted from its
-- start, a campaign's report has every click; one that started earlier only has the clicks since.
ALTER TABLE campaigns ADD COLUMN linksCountedAt INTEGER;

-- A sent campaign's report reads its emails and its link clicks by account and campaign. Without statistics, SQLite
-- picks an index on the account alone over one on the campaign alone, and reads every email or event the account has:
-- these name both. The recipients list pages through the emails by contact, and each page finds its clicks by email.
CREATE INDEX messages_account_campaign ON messages(accountId, campaignId, kind, contactId);
CREATE INDEX events_account_campaign ON events(accountId, campaignId, type, messageId);
