CREATE INDEX contacts_newsletter_id ON contacts(newsletterId, _id);
DROP INDEX messages_newsletter_sent;
CREATE INDEX messages_newsletter_sent ON messages(newsletterId, sentAt, _id);
