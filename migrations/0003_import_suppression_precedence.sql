-- An imported bounce/complaint must also outrank an existing manual suppression.
DROP TRIGGER contacts_insert_suppressed;
CREATE TRIGGER contacts_insert_suppressed
AFTER INSERT ON contacts
WHEN EXISTS (SELECT 1 FROM suppressions WHERE email = NEW.email)
BEGIN
  UPDATE contacts SET status = CASE
    WHEN NEW.status = 'complained' OR (SELECT reason FROM suppressions WHERE email = NEW.email) = 'complaint' THEN 'complained'
    WHEN NEW.status = 'bounced' OR (SELECT reason FROM suppressions WHERE email = NEW.email) = 'bounce' THEN 'bounced'
    ELSE 'unsubscribed' END
  WHERE _id = NEW._id;
END;
