-- The DMARC record found on the domain, or on the closest parent with one (lib/dmarc-rules.js): { status, host }.
ALTER TABLE domains ADD COLUMN dmarc TEXT CHECK (dmarc IS NULL OR (json_valid(dmarc) AND json_type(dmarc) = 'object'));
-- The Domains page's last read of a domain still being set up, which the provider's verification budget doesn't count
-- (checkedAt does).
ALTER TABLE domains ADD COLUMN readAt INTEGER;
