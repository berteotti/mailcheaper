-- A newsletter's welcome emails over the overview's period and the one before, up to two years, without reading every
-- account's through messages_kind_created.
CREATE INDEX messages_newsletter_welcome ON messages(newsletterId, createdAt) WHERE kind = 'welcome';
