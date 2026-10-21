-- A campaign's language (lib/languages.js), null while its newsletter's applies: it goes to the contacts reading it.
-- A send pins it, so a sent campaign keeps the language it went out in.
ALTER TABLE campaigns ADD COLUMN language TEXT
  CHECK (language IS NULL OR (length(language) BETWEEN 2 AND 3 AND language NOT GLOB '*[^a-z]*'));
ALTER TABLE campaigns ADD COLUMN languageRegion TEXT
  CHECK (languageRegion IS NULL OR (language IS NOT NULL AND (languageRegion GLOB '[A-Z][A-Z]' OR languageRegion GLOB '[0-9][0-9][0-9]')));

-- The same issue in another language: one send, and each contact gets the edition in theirs (lib/editions.js).
CREATE TABLE campaign_editions (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  accountId TEXT NOT NULL REFERENCES accounts(_id) ON DELETE RESTRICT,
  campaignId TEXT NOT NULL REFERENCES campaigns(_id) ON DELETE RESTRICT,
  language TEXT NOT NULL CHECK (length(language) BETWEEN 2 AND 3 AND language NOT GLOB '*[^a-z]*'),
  languageRegion TEXT CHECK (languageRegion IS NULL OR languageRegion GLOB '[A-Z][A-Z]' OR languageRegion GLOB '[0-9][0-9][0-9]'),
  subject TEXT NOT NULL DEFAULT '',
  previewText TEXT NOT NULL DEFAULT '',
  format TEXT NOT NULL DEFAULT 'rich' CHECK (format IN ('markdown', 'html', 'rich')),
  markdown TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX campaign_editions_language ON campaign_editions(campaignId, language, coalesce(languageRegion, ''));

-- The edition a campaign email went out in, null for the campaign's own. The index serves the foreign key check of
-- every edition deleted.
ALTER TABLE messages ADD COLUMN editionId TEXT REFERENCES campaign_editions(_id) ON DELETE RESTRICT;
CREATE INDEX messages_edition ON messages(editionId) WHERE editionId IS NOT NULL;
