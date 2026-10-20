-- Deleting a newsletter's messages finds their events by message, and so does each delete's foreign key check:
-- without it, every message deleted would read the whole events table.
CREATE INDEX events_message ON events(messageId);
