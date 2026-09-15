ALTER TYPE "CommentStatus" ADD VALUE 'DELETED';

CREATE TYPE "CommentEmailStatus" AS ENUM ('PENDING', 'DEVELOPMENT', 'SENT', 'FAILED', 'NOT_APPLICABLE');

ALTER TABLE "comments"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "moderationEmailStatus" "CommentEmailStatus",
  ADD COLUMN "moderationEmailMessageId" TEXT,
  ADD COLUMN "moderationEmailError" TEXT;

CREATE INDEX "comments_deletedAt_idx" ON "comments"("deletedAt");
