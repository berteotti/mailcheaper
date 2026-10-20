-- Base languages only (lib/languages.js): pt-BR and pt-PT readers are one Portuguese list. A contact's language is
-- null until it's known, and the newsletter's applies.
ALTER TABLE newsletters ADD COLUMN language TEXT NOT NULL DEFAULT 'en'
  CHECK (length(language) BETWEEN 2 AND 3 AND language NOT GLOB '*[^a-z]*');
ALTER TABLE contacts ADD COLUMN language TEXT
  CHECK (language IS NULL OR (length(language) BETWEEN 2 AND 3 AND language NOT GLOB '*[^a-z]*'));
