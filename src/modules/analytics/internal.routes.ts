import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { safeHashEqual, sha256 } from '../../lib/crypto.js';

export const internalAnalyticsRoutes: FastifyPluginAsync = async app => {
  app.post('/internal/analytics/aggregate', async (request, reply) => {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
    if (!token || !safeHashEqual(token, sha256(app.config.cronSecret))) {
      throw new AppError(401, 'INVALID_CRON_SECRET', 'Credencial de tarea inválida.');
    }
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const affected = await app.prisma.$executeRaw(Prisma.sql`
      INSERT INTO analytics_daily (
        id, day, type, "dimensionKey", "noteId", "editionId", "resourceId", segment,
        "sourceCategory", "eventCount", "uniqueReaders", "valueSum", "createdAt", "updatedAt"
      )
      SELECT
        gen_random_uuid(), DATE("occurredAt"), type,
        CONCAT(COALESCE("noteId"::text, '-'), '|', COALESCE("editionId"::text, '-'), '|', COALESCE("resourceId"::text, '-'), '|', COALESCE(segment, '-'), '|', COALESCE("sourceCategory", '-')),
        "noteId"::text, "editionId"::text, "resourceId"::text, segment, "sourceCategory",
        COUNT(*)::int, COUNT(DISTINCT "sessionHash")::int,
        COALESCE(SUM(COALESCE("durationSeconds", "progressPercent", 0)), 0)::int,
        NOW(), NOW()
      FROM analytics_events
      WHERE "occurredAt" < ${today}
      GROUP BY DATE("occurredAt"), type, "noteId", "editionId", "resourceId", segment, "sourceCategory"
      ON CONFLICT (day, type, "dimensionKey") DO UPDATE SET
        "eventCount" = EXCLUDED."eventCount",
        "uniqueReaders" = EXCLUDED."uniqueReaders",
        "valueSum" = EXCLUDED."valueSum",
        "updatedAt" = NOW()
    `);
    const cutoff = new Date(Date.now() - app.config.analyticsRawRetentionDays * 24 * 60 * 60 * 1_000);
    const removed = await app.prisma.analyticsEvent.deleteMany({ where: { occurredAt: { lt: cutoff } } });
    return reply.send({ aggregatedGroups: affected, removedRawEvents: removed.count, cutoff: cutoff.toISOString() });
  });
};
