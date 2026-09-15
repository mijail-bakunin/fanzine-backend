ALTER TABLE "site_settings"
  ADD COLUMN "contentByLocale" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "seoByLocale" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "editions"
  ADD COLUMN "localizedContent" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "notes"
  ADD COLUMN "localizedContent" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "categories"
  ADD COLUMN "localizedContent" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "resources"
  ADD COLUMN "localizedContent" JSONB NOT NULL DEFAULT '{}';
