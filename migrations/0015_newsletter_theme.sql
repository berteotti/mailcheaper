-- A newsletter's look on its website and in its emails (lib/themes.js): a preset and only what was changed on top of
-- it. Null: MailCheap's own.
ALTER TABLE newsletters ADD COLUMN theme TEXT CHECK (theme IS NULL OR (json_valid(theme) AND json_type(theme) = 'object'));
