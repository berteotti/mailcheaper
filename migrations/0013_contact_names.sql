-- A contact's first and last name, from a signup, an import or the dashboard: null while nobody gave one.
ALTER TABLE contacts ADD COLUMN firstName TEXT CHECK (firstName IS NULL OR length(firstName) BETWEEN 1 AND 100);
ALTER TABLE contacts ADD COLUMN lastName TEXT CHECK (lastName IS NULL OR length(lastName) BETWEEN 1 AND 100);
