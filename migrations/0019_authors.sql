-- Who writes a newsletter's issues (lib/authors.js): the name and picture their emails and pages show, where they show
-- them, and the address replies to their issues go to, which neither ever shows. A removed author is kept with deletedAt
-- and shows nowhere.
CREATE TABLE authors (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  accountId TEXT NOT NULL REFERENCES accounts(_id) ON DELETE RESTRICT,
  newsletterId TEXT NOT NULL REFERENCES newsletters(_id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(name) > 0),
  email TEXT NOT NULL CHECK (length(email) > 0 AND email = lower(trim(email))),
  imageUrl TEXT,
  showOnWeb INTEGER NOT NULL DEFAULT 1 CHECK (showOnWeb IN (0, 1)),
  showInEmails INTEGER NOT NULL DEFAULT 1 CHECK (showInEmails IN (0, 1)),
  deletedAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX authors_newsletter ON authors(accountId, newsletterId, createdAt);

-- An issue's author, and the one its send started with, kept so every email of a send shows the same: { name, email,
-- imageUrl, showInEmails }. Read through lib/authors.js with the issue's account and newsletter, so no foreign keys:
-- a newsletter's default author and its authors would point at each other.
ALTER TABLE campaigns ADD COLUMN authorId TEXT;
ALTER TABLE campaigns ADD COLUMN sentAuthor TEXT CHECK (sentAuthor IS NULL OR (json_valid(sentAuthor) AND json_type(sentAuthor) = 'object'));
-- The author a newsletter's new issues start with.
ALTER TABLE newsletters ADD COLUMN defaultAuthorId TEXT;
