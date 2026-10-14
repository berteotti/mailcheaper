-- When a connected app last used its access token (lib/oauth.js), shown on the API keys page. Better Auth's own
-- schema has no such column; it writes ISO strings, so this holds one too.
ALTER TABLE "oauthConsent" ADD COLUMN "lastUsedAt" date;
