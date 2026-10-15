-- Consumers mark handled jobs; the cron prunes them after a retention window.
ALTER TABLE job_outbox ADD COLUMN completedAt INTEGER;
CREATE INDEX job_outbox_completed ON job_outbox(completedAt) WHERE completedAt IS NOT NULL;
-- Ambiguous sends are reconciled from SES events or reviewed by the admin.
CREATE INDEX messages_ambiguous ON messages(campaignId, updatedAt) WHERE status = 'ambiguous';
