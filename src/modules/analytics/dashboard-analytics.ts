import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';

type CountRow = { value: bigint | number | null };

export async function buildDashboardAnalytics(prisma: PrismaClient, from: Date) {
  const [visits, uniqueReaders, completedReads, readingTime, downloads, comments, ratings, timeline, topNotes, attention, sources] = await Promise.all([
    prisma.analyticsEvent.count({ where: { type: 'PAGE_VIEW', occurredAt: { gte: from } } }),
    prisma.$queryRaw<CountRow[]>(Prisma.sql`SELECT COUNT(DISTINCT "sessionHash") AS value FROM analytics_events WHERE "occurredAt" >= ${from} AND "sessionHash" IS NOT NULL`),
    prisma.analyticsEvent.count({ where: { type: 'READING_COMPLETED', occurredAt: { gte: from } } }),
    prisma.analyticsEvent.aggregate({ where: { type: 'READING_TIME', occurredAt: { gte: from } }, _avg: { durationSeconds: true } }),
    prisma.analyticsEvent.count({ where: { type: 'DOWNLOAD', occurredAt: { gte: from } } }),
    prisma.comment.count({ where: { createdAt: { gte: from } } }),
    prisma.noteRating.aggregate({ where: { updatedAt: { gte: from } }, _avg: { score: true }, _count: { score: true } }),
    prisma.$queryRaw<Array<{ day: Date; visits: bigint; reads: bigint }>>(Prisma.sql`
      SELECT DATE("occurredAt") AS day,
        COUNT(*) FILTER (WHERE type = 'PAGE_VIEW') AS visits,
        COUNT(*) FILTER (WHERE type = 'READING_COMPLETED') AS reads
      FROM analytics_events WHERE "occurredAt" >= ${from}
      GROUP BY DATE("occurredAt") ORDER BY day ASC
    `),
    prisma.$queryRaw<Array<{ note_id: string; title: string; visits: bigint; completion: number | null; rating: number | null }>>(Prisma.sql`
      SELECT n.id AS note_id, n.title,
        (SELECT COUNT(*) FROM analytics_events a WHERE a."noteId" = n.id AND a.type = 'PAGE_VIEW' AND a."occurredAt" >= ${from}) AS visits,
        (SELECT 100.0 * COUNT(*) FILTER (WHERE a.type = 'READING_COMPLETED') / NULLIF(COUNT(*) FILTER (WHERE a.type = 'READING_STARTED'), 0)
          FROM analytics_events a WHERE a."noteId" = n.id AND a."occurredAt" >= ${from}) AS completion,
        (SELECT AVG(r.score) FROM note_ratings r WHERE r."noteId" = n.id) AS rating
      FROM notes n WHERE n.status <> 'DELETED'
      ORDER BY visits DESC, n.title ASC LIMIT 8
    `),
    prisma.$queryRaw<Array<{ segment: string | null; value: number | null }>>(Prisma.sql`
      SELECT segment, AVG(COALESCE("progressPercent", 0)) AS value
      FROM analytics_events WHERE type = 'ATTENTION' AND "occurredAt" >= ${from}
      GROUP BY segment ORDER BY MIN("occurredAt")
    `),
    prisma.$queryRaw<Array<{ source: string | null; value: bigint }>>(Prisma.sql`
      SELECT COALESCE("sourceCategory", 'direct') AS source, COUNT(*) AS value
      FROM analytics_events WHERE type IN ('PAGE_VIEW', 'REFERRAL') AND "occurredAt" >= ${from}
      GROUP BY COALESCE("sourceCategory", 'direct') ORDER BY value DESC
    `),
  ]);

  const sourceTotal = sources.reduce((total, item) => total + Number(item.value), 0) || 1;
  return {
    summary: {
      visits,
      uniqueReaders: Number(uniqueReaders[0]?.value ?? 0),
      completedReads,
      avgReadingSeconds: Math.round(readingTime._avg.durationSeconds ?? 0),
      downloads,
      comments,
      ratings: ratings._count.score,
      avgRating: Number((ratings._avg.score ?? 0).toFixed(1)),
    },
    timeline: timeline.map(item => ({
      label: new Intl.DateTimeFormat('es-AR', { weekday: 'short', timeZone: 'UTC' }).format(item.day).replace('.', ''),
      date: item.day.toISOString().slice(0, 10),
      visits: Number(item.visits),
      reads: Number(item.reads),
    })),
    topNotes: topNotes.map(item => ({
      noteId: item.note_id,
      title: item.title,
      visits: Number(item.visits),
      completion: Math.round(Number(item.completion ?? 0)),
      rating: Number(Number(item.rating ?? 0).toFixed(1)),
    })),
    attention: attention.length ? attention.map(item => ({ label: item.segment ?? 'Sin tramo', value: Math.round(Number(item.value ?? 0)) })) : [
      { label: 'Inicio', value: 0 }, { label: 'Primer tercio', value: 0 }, { label: 'Segundo tercio', value: 0 }, { label: 'Final', value: 0 },
    ],
    sources: sources.map(item => ({
      label: sourceLabel(item.source),
      value: Math.round(Number(item.value) * 100 / sourceTotal),
      count: Number(item.value),
    })),
  };
}

function sourceLabel(value: string | null) {
  return ({ direct: 'Directo', social: 'Redes', search: 'Búsqueda', referral: 'Referencias' } as Record<string, string>)[value ?? 'direct'] ?? 'Otros';
}
