-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('READER', 'ADMIN', 'EDITOR', 'MODERATOR');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'DELETED');

-- CreateEnum
CREATE TYPE "EditorialStatus" AS ENUM ('DRAFT', 'REVIEW', 'SCHEDULED', 'PUBLISHED', 'ARCHIVED', 'DELETED');

-- CreateEnum
CREATE TYPE "PublicationKind" AS ENUM ('MAGAZINE', 'BOOK');

-- CreateEnum
CREATE TYPE "ResourceType" AS ENUM ('IMAGE', 'VIDEO', 'AUDIO', 'PDF', 'LINK');

-- CreateEnum
CREATE TYPE "StorageDriver" AS ENUM ('EXTERNAL', 'LOCAL', 'S3');

-- CreateEnum
CREATE TYPE "UploadStatus" AS ENUM ('PENDING', 'UPLOADING', 'COMPLETE', 'FAILED', 'ABORTED');

-- CreateEnum
CREATE TYPE "CommentStatus" AS ENUM ('PENDING', 'VISIBLE', 'HIDDEN', 'REPORTED');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'ANSWERED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ContactReplyStatus" AS ENUM ('DRAFT', 'QUEUED', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "OAuthProvider" AS ENUM ('GOOGLE', 'X');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('INFO', 'WARNING', 'ERROR');

-- CreateEnum
CREATE TYPE "MetricEventType" AS ENUM ('PAGE_VIEW', 'READING_STARTED', 'READING_COMPLETED', 'READING_TIME', 'ATTENTION', 'DOWNLOAD', 'COMMENT', 'RATING', 'REFERRAL');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'READER',
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "avatarUrl" TEXT,
    "lastLoginAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profiles" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "publicName" TEXT,
    "bio" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'es',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "theme" TEXT NOT NULL DEFAULT 'dark',
    "locale" TEXT NOT NULL DEFAULT 'es',
    "readingSize" TEXT NOT NULL DEFAULT 'normal',
    "readingFont" TEXT NOT NULL DEFAULT 'editorial',
    "contrast" TEXT NOT NULL DEFAULT 'standard',
    "analyticsOptOut" BOOLEAN NOT NULL DEFAULT false,
    "extra" JSONB,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_accounts" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" "OAuthProvider" NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "tokenCiphertext" TEXT,
    "refreshCiphertext" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_settings" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "brandName" TEXT NOT NULL DEFAULT 'La Guillotina',
    "publicationType" TEXT NOT NULL DEFAULT 'Revista anarquista',
    "statement" TEXT NOT NULL DEFAULT 'Contra toda autoridad',
    "headerLine" TEXT NOT NULL DEFAULT 'REVISTA ANARQUISTA / CONTRA TODA AUTORIDAD',
    "navigation" JSONB NOT NULL,
    "footerStatement" TEXT NOT NULL,
    "socialPrompt" TEXT NOT NULL,
    "socialLinks" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "site_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "editions" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "PublicationKind" NOT NULL DEFAULT 'MAGAZINE',
    "number" INTEGER,
    "title" TEXT NOT NULL,
    "subtitle" TEXT,
    "author" TEXT,
    "dateLabel" TEXT NOT NULL,
    "theme" TEXT,
    "summary" TEXT,
    "publication" TEXT NOT NULL DEFAULT 'La Guillotina',
    "headerLine" TEXT NOT NULL DEFAULT 'REVISTA ANARQUISTA / CONTRA TODA AUTORIDAD',
    "status" "EditorialStatus" NOT NULL DEFAULT 'DRAFT',
    "coverResourceId" UUID,
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "editions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "editionId" UUID,
    "title" TEXT NOT NULL,
    "excerpt" TEXT NOT NULL,
    "bodyMarkdown" TEXT NOT NULL,
    "authorName" TEXT NOT NULL DEFAULT 'Redacción',
    "status" "EditorialStatus" NOT NULL DEFAULT 'DRAFT',
    "readingMinutes" INTEGER NOT NULL DEFAULT 3,
    "fragment" TEXT,
    "x" INTEGER,
    "y" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "tone" TEXT NOT NULL DEFAULT 'red',
    "readMoreLabel" TEXT NOT NULL DEFAULT 'LEER +',
    "readMoreSubtitle" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "editionLink" BOOLEAN NOT NULL DEFAULT false,
    "scheduledAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "color" TEXT NOT NULL,
    "status" "EditorialStatus" NOT NULL DEFAULT 'PUBLISHED',
    "deletedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_categories" (
    "noteId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_categories_pkey" PRIMARY KEY ("noteId","categoryId")
);

-- CreateTable
CREATE TABLE "resources" (
    "id" UUID NOT NULL,
    "type" "ResourceType" NOT NULL,
    "storageDriver" "StorageDriver" NOT NULL DEFAULT 'EXTERNAL',
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "objectKey" TEXT,
    "fileName" TEXT,
    "fileSize" INTEGER NOT NULL DEFAULT 0,
    "mimeType" TEXT,
    "alt" TEXT NOT NULL,
    "credit" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "status" "EditorialStatus" NOT NULL DEFAULT 'DRAFT',
    "uploadStatus" "UploadStatus" NOT NULL DEFAULT 'COMPLETE',
    "width" INTEGER,
    "height" INTEGER,
    "durationSeconds" INTEGER,
    "checksum" TEXT,
    "resourceDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_resources" (
    "noteId" UUID NOT NULL,
    "resourceId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'attachment',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_resources_pkey" PRIMARY KEY ("noteId","resourceId")
);

-- CreateTable
CREATE TABLE "edition_resources" (
    "editionId" UUID NOT NULL,
    "resourceId" UUID NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'attachment',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "edition_resources_pkey" PRIMARY KEY ("editionId","resourceId")
);

-- CreateTable
CREATE TABLE "resource_uploads" (
    "id" UUID NOT NULL,
    "resourceId" UUID NOT NULL,
    "createdById" UUID,
    "providerId" TEXT,
    "objectKey" TEXT NOT NULL,
    "status" "UploadStatus" NOT NULL DEFAULT 'PENDING',
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "parts" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resource_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "noteId" UUID NOT NULL,
    "userId" UUID,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "CommentStatus" NOT NULL DEFAULT 'PENDING',
    "reportCount" INTEGER NOT NULL DEFAULT 0,
    "moderationNote" TEXT,
    "moderatedById" UUID,
    "moderatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_votes" (
    "id" UUID NOT NULL,
    "commentId" UUID NOT NULL,
    "userId" UUID,
    "voterKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_votes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comment_reports" (
    "id" UUID NOT NULL,
    "commentId" UUID NOT NULL,
    "reporterId" UUID,
    "reporterKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comment_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "note_ratings" (
    "id" UUID NOT NULL,
    "noteId" UUID NOT NULL,
    "userId" UUID,
    "voterKey" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "note_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_notes" (
    "userId" UUID NOT NULL,
    "noteId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_notes_pkey" PRIMARY KEY ("userId","noteId")
);

-- CreateTable
CREATE TABLE "contact_messages" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ContactStatus" NOT NULL DEFAULT 'NEW',
    "assignedToId" UUID,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_replies" (
    "id" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "authorId" UUID,
    "body" TEXT NOT NULL,
    "status" "ContactReplyStatus" NOT NULL DEFAULT 'DRAFT',
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_logs" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "requestId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "error_logs" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "route" TEXT,
    "method" TEXT,
    "statusCode" INTEGER NOT NULL,
    "requestId" TEXT,
    "context" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "error_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" UUID NOT NULL,
    "type" "MetricEventType" NOT NULL,
    "sessionHash" TEXT,
    "editionId" UUID,
    "noteId" UUID,
    "resourceId" UUID,
    "segment" TEXT,
    "sourceCategory" TEXT,
    "durationSeconds" INTEGER,
    "progressPercent" INTEGER,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_daily" (
    "id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "type" "MetricEventType" NOT NULL,
    "dimensionKey" TEXT NOT NULL,
    "noteId" TEXT,
    "editionId" TEXT,
    "resourceId" TEXT,
    "segment" TEXT,
    "sourceCategory" TEXT,
    "eventCount" INTEGER NOT NULL DEFAULT 0,
    "uniqueReaders" INTEGER NOT NULL DEFAULT 0,
    "valueSum" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "analytics_daily_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_status_idx" ON "users"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "user_profiles_userId_key" ON "user_profiles"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_userId_key" ON "user_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_expiresAt_idx" ON "sessions"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_accounts_provider_providerAccountId_key" ON "oauth_accounts"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_accounts_userId_provider_key" ON "oauth_accounts"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_tokenHash_key" ON "password_reset_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_userId_expiresAt_idx" ON "password_reset_tokens"("userId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "editions_slug_key" ON "editions"("slug");

-- CreateIndex
CREATE INDEX "editions_status_publishedAt_idx" ON "editions"("status", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "editions_kind_number_key" ON "editions"("kind", "number");

-- CreateIndex
CREATE UNIQUE INDEX "notes_slug_key" ON "notes"("slug");

-- CreateIndex
CREATE INDEX "notes_editionId_status_sortOrder_idx" ON "notes"("editionId", "status", "sortOrder");

-- CreateIndex
CREATE INDEX "notes_status_publishedAt_idx" ON "notes"("status", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "categories_name_key" ON "categories"("name");

-- CreateIndex
CREATE INDEX "categories_status_name_idx" ON "categories"("status", "name");

-- CreateIndex
CREATE INDEX "resources_type_status_createdAt_idx" ON "resources"("type", "status", "createdAt");

-- CreateIndex
CREATE INDEX "resources_objectKey_idx" ON "resources"("objectKey");

-- CreateIndex
CREATE INDEX "resource_uploads_status_expiresAt_idx" ON "resource_uploads"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "comments_noteId_status_createdAt_idx" ON "comments"("noteId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "comments_status_reportCount_idx" ON "comments"("status", "reportCount");

-- CreateIndex
CREATE INDEX "comment_votes_userId_idx" ON "comment_votes"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "comment_votes_commentId_voterKey_key" ON "comment_votes"("commentId", "voterKey");

-- CreateIndex
CREATE INDEX "comment_reports_reviewedAt_createdAt_idx" ON "comment_reports"("reviewedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "comment_reports_commentId_reporterKey_key" ON "comment_reports"("commentId", "reporterKey");

-- CreateIndex
CREATE INDEX "note_ratings_userId_idx" ON "note_ratings"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "note_ratings_noteId_voterKey_key" ON "note_ratings"("noteId", "voterKey");

-- CreateIndex
CREATE INDEX "contact_messages_status_receivedAt_idx" ON "contact_messages"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "contact_replies_contactId_createdAt_idx" ON "contact_replies"("contactId", "createdAt");

-- CreateIndex
CREATE INDEX "admin_logs_level_createdAt_idx" ON "admin_logs"("level", "createdAt");

-- CreateIndex
CREATE INDEX "admin_logs_entityType_entityId_idx" ON "admin_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "error_logs_statusCode_createdAt_idx" ON "error_logs"("statusCode", "createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_type_occurredAt_idx" ON "analytics_events"("type", "occurredAt");

-- CreateIndex
CREATE INDEX "analytics_events_noteId_occurredAt_idx" ON "analytics_events"("noteId", "occurredAt");

-- CreateIndex
CREATE INDEX "analytics_events_sessionHash_occurredAt_idx" ON "analytics_events"("sessionHash", "occurredAt");

-- CreateIndex
CREATE INDEX "analytics_daily_day_type_idx" ON "analytics_daily"("day", "type");

-- CreateIndex
CREATE UNIQUE INDEX "analytics_daily_day_type_dimensionKey_key" ON "analytics_daily"("day", "type", "dimensionKey");

-- AddForeignKey
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editions" ADD CONSTRAINT "editions_coverResourceId_fkey" FOREIGN KEY ("coverResourceId") REFERENCES "resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editions" ADD CONSTRAINT "editions_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editions" ADD CONSTRAINT "editions_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "editions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_categories" ADD CONSTRAINT "note_categories_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_categories" ADD CONSTRAINT "note_categories_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resources" ADD CONSTRAINT "resources_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_resources" ADD CONSTRAINT "note_resources_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_resources" ADD CONSTRAINT "note_resources_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edition_resources" ADD CONSTRAINT "edition_resources_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "editions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "edition_resources" ADD CONSTRAINT "edition_resources_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_uploads" ADD CONSTRAINT "resource_uploads_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_uploads" ADD CONSTRAINT "resource_uploads_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_moderatedById_fkey" FOREIGN KEY ("moderatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_votes" ADD CONSTRAINT "comment_votes_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_votes" ADD CONSTRAINT "comment_votes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_reports" ADD CONSTRAINT "comment_reports_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_reports" ADD CONSTRAINT "comment_reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_reports" ADD CONSTRAINT "comment_reports_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_ratings" ADD CONSTRAINT "note_ratings_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "note_ratings" ADD CONSTRAINT "note_ratings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_notes" ADD CONSTRAINT "saved_notes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_notes" ADD CONSTRAINT "saved_notes_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_messages" ADD CONSTRAINT "contact_messages_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_replies" ADD CONSTRAINT "contact_replies_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contact_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_replies" ADD CONSTRAINT "contact_replies_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_logs" ADD CONSTRAINT "admin_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "editions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analytics_events" ADD CONSTRAINT "analytics_events_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "resources"("id") ON DELETE SET NULL ON UPDATE CASCADE;
