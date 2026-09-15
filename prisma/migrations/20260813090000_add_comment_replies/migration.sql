-- Add one-level public discussion threads while retaining existing comments as roots.
ALTER TABLE "comments" ADD COLUMN "parentId" UUID;

CREATE INDEX "comments_noteId_parentId_status_createdAt_idx"
ON "comments"("noteId", "parentId", "status", "createdAt");

ALTER TABLE "comments"
ADD CONSTRAINT "comments_parentId_fkey"
FOREIGN KEY ("parentId") REFERENCES "comments"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
