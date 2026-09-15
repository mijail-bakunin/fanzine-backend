-- Add optional editorial controls for cover composition without changing existing notes.
ALTER TABLE "notes"
ADD COLUMN "coverTitleLines" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "coverExcerpt" TEXT,
ADD COLUMN "coverButtonPosition" JSONB,
ADD COLUMN "coverDepth" INTEGER;

ALTER TABLE "notes"
ADD CONSTRAINT "notes_coverDepth_check"
CHECK ("coverDepth" IS NULL OR ("coverDepth" >= 0 AND "coverDepth" <= 100));
