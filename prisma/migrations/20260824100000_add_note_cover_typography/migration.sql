ALTER TABLE "notes"
  ADD COLUMN "coverTypography" JSONB NOT NULL DEFAULT '{"titleSize":"standard","titleAlign":"left","titleTreatment":"brush","excerptSize":"standard"}'::jsonb;
