-- The last time an admin unblocked the account: the bounces and complaints of the emails sent before don't block it
-- again (lib/sending-rules.js getAccountCheckWindow).
ALTER TABLE accounts ADD COLUMN unblockedAt INTEGER;
