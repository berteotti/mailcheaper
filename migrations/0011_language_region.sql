-- A language's regional variant (lib/languages.js): BR for a newsletter in Brazilian Portuguese. language stays the
-- base, so whatever looks for Portuguese finds every variant.
ALTER TABLE newsletters ADD COLUMN languageRegion TEXT
  CHECK (languageRegion IS NULL OR languageRegion GLOB '[A-Z][A-Z]' OR languageRegion GLOB '[0-9][0-9][0-9]');
ALTER TABLE contacts ADD COLUMN languageRegion TEXT
  CHECK (languageRegion IS NULL OR (language IS NOT NULL AND (languageRegion GLOB '[A-Z][A-Z]' OR languageRegion GLOB '[0-9][0-9][0-9]')));
