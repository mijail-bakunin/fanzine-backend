ALTER TABLE "editions"
  ADD COLUMN "coverArt" JSONB NOT NULL DEFAULT '{"preset":"archive","elements":[]}'::jsonb;
