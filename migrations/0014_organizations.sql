-- Organizations: an account belongs to one, and its members sign in to it (lib/organizations.js). A person belongs to
-- one organization at most. Owners invite and remove people, handle billing and can delete it; members do the rest.
CREATE TABLE organizations (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 100),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

-- users.id is Better Auth's: deleting a user takes their membership with it.
CREATE TABLE members (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  organizationId TEXT NOT NULL REFERENCES organizations(_id) ON DELETE CASCADE,
  userId TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE INDEX members_organization ON members(organizationId, createdAt);

-- Someone asked to join, by email, until they join, decline or it expires. Asking again renews it.
CREATE TABLE invitations (
  _id TEXT PRIMARY KEY NOT NULL CHECK (length(_id) = 24 AND _id NOT GLOB '*[^0-9a-f]*'),
  organizationId TEXT NOT NULL REFERENCES organizations(_id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK (length(email) > 0 AND email = lower(trim(email))),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  invitedBy TEXT REFERENCES users(id) ON DELETE SET NULL,
  expiresAt INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
CREATE UNIQUE INDEX invitations_organization_email ON invitations(organizationId, email);
CREATE INDEX invitations_email ON invitations(email, expiresAt);

-- Always set from now on; SQLite only adds a nullable column with a foreign key. accounts.ownerId stays, because SQLite
-- drops a UNIQUE column only by rebuilding the table, which every customer table references: nothing reads it anymore,
-- and new accounts write their organization's id in it.
ALTER TABLE accounts ADD COLUMN organizationId TEXT REFERENCES organizations(_id) ON DELETE RESTRICT;
CREATE UNIQUE INDEX accounts_organization ON accounts(organizationId) WHERE organizationId IS NOT NULL;

-- Each account so far had one user: it becomes the owner of an organization named after them, with the account's id.
INSERT INTO organizations (_id, name, createdAt, updatedAt)
SELECT a._id, substr(coalesce(nullif(trim(u.name), ''), nullif(substr(u.email, 1, instr(u.email, '@') - 1), ''), 'My organization'), 1, 100), a.createdAt, a.updatedAt
FROM accounts a LEFT JOIN users u ON u.id = a.ownerId;
UPDATE accounts SET organizationId = _id;
INSERT INTO members (_id, organizationId, userId, role, createdAt, updatedAt)
SELECT lower(hex(randomblob(12))), a._id, a.ownerId, 'owner', a.createdAt, a.createdAt
FROM accounts a JOIN users u ON u.id = a.ownerId;
