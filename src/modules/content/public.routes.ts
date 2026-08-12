import type { FastifyPluginAsync } from 'fastify';
import { Prisma } from '../../generated/prisma/client.js';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { hmacSha256 } from '../../lib/crypto.js';
import { paginationMeta, pageWindow } from '../../lib/pagination.js';
import { parse } from '../../lib/validation.js';
import { voterIdentity } from '../auth/auth-context.js';
import { findNote, noteWhere } from './note-lookup.js';
import { serializeComment, serializePublicNote, serializeResource, serializeSiteSettings } from './serializers.js';

const idParams = z.object({ noteId: z.string().trim().min(1).max(100) });

export const publicContentRoutes: FastifyPluginAsync = async app => {
  app.get('/site/settings', async () => {
    const settings = await app.prisma.siteSettings.findUnique({ where: { id: 'default' } });
    if (!settings) throw new AppError(503, 'SITE_SETTINGS_NOT_CONFIGURED', 'La configuración editorial todavía no está disponible.');
    return serializeSiteSettings(settings);
  });

  app.get('/editions', async request => {
    const query = parse(z.object({
      kind: z.enum(['magazine', 'book']).default('magazine'),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(12),
    }), request.query);
    const where = { kind: query.kind.toUpperCase() as 'MAGAZINE' | 'BOOK', status: 'PUBLISHED' as const };
    const [items, total] = await app.prisma.$transaction([
      app.prisma.edition.findMany({ where, orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      app.prisma.edition.count({ where }),
    ]);
    return {
      items: items.map(edition => ({
        id: edition.id, slug: edition.slug, kind: edition.kind.toLowerCase(), number: edition.number,
        title: edition.title, subtitle: edition.subtitle, author: edition.author, date: edition.dateLabel,
        theme: edition.theme, summary: edition.summary,
      })),
      pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) },
    };
  });

  app.get('/catalog', async request => {
    const query = parse(z.object({
      section: z.enum(['all', 'magazines', 'books', 'showcase', 'multimedia']).default('all'),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(12),
      search: z.string().trim().max(120).optional(),
      tag: z.string().trim().max(120).optional(),
      type: z.enum(['image', 'video', 'audio', 'pdf', 'link']).optional(),
    }), request.query);
    const window = pageWindow(query.page, query.pageSize);
    const includeSection = (section: Exclude<typeof query.section, 'all'>) => query.section === 'all' || query.section === section;
    const contains = query.search ? { contains: query.search, mode: 'insensitive' as const } : undefined;
    const tagFilter = query.tag ? {
      notes: { some: { status: 'PUBLISHED' as const, categories: { some: { category: { slug: query.tag, status: 'PUBLISHED' as const } } } } },
    } : {};
    const editionWhere = (kind: 'MAGAZINE' | 'BOOK'): Prisma.EditionWhereInput => ({
      kind,
      status: 'PUBLISHED',
      ...(contains ? { OR: [{ title: contains }, { subtitle: contains }, { summary: contains }, { theme: contains }, { author: contains }] } : {}),
      ...tagFilter,
    });
    const resourceWhere = (section: 'showcase' | 'multimedia'): Prisma.ResourceWhereInput => {
      const allowedTypes = section === 'showcase' ? ['IMAGE'] : ['VIDEO', 'AUDIO', 'PDF', 'LINK'];
      const requestedType = query.type?.toUpperCase();
      const types = requestedType && allowedTypes.includes(requestedType) ? [requestedType] : requestedType ? [] : allowedTypes;
      return {
        status: 'PUBLISHED',
        uploadStatus: 'COMPLETE',
        type: { in: types as Array<'IMAGE' | 'VIDEO' | 'AUDIO' | 'PDF' | 'LINK'> },
        ...(contains ? { OR: [{ name: contains }, { alt: contains }, { credit: contains }, { license: contains }] } : {}),
        ...(query.tag ? { notes: { some: { note: { status: 'PUBLISHED', categories: { some: { category: { slug: query.tag, status: 'PUBLISHED' } } } } } } } : {}),
      };
    };
    const editionInclude = {
      coverResource: true,
      notes: {
        where: { status: 'PUBLISHED' as const },
        select: { categories: { select: { category: { select: { slug: true, name: true } } } } },
      },
    } as const;
    const resourceInclude = {
      notes: {
        where: { note: { status: 'PUBLISHED' as const } },
        select: {
          role: true,
          note: {
            select: {
              slug: true,
              title: true,
              categories: { select: { category: { select: { slug: true, name: true } } } },
            },
          },
        },
      },
      editions: {
        where: { edition: { status: 'PUBLISHED' as const } },
        select: { role: true, edition: { select: { slug: true, title: true, kind: true } } },
      },
    } as const;

    const [magazines, magazineTotal, books, bookTotal, showcase, showcaseTotal, multimedia, multimediaTotal] = await Promise.all([
      includeSection('magazines') ? app.prisma.edition.findMany({ where: editionWhere('MAGAZINE'), ...window, orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }], include: editionInclude }) : [],
      includeSection('magazines') ? app.prisma.edition.count({ where: editionWhere('MAGAZINE') }) : 0,
      includeSection('books') ? app.prisma.edition.findMany({ where: editionWhere('BOOK'), ...window, orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }], include: editionInclude }) : [],
      includeSection('books') ? app.prisma.edition.count({ where: editionWhere('BOOK') }) : 0,
      includeSection('showcase') ? app.prisma.resource.findMany({ where: resourceWhere('showcase'), ...window, orderBy: [{ resourceDate: 'desc' }, { createdAt: 'desc' }], include: resourceInclude }) : [],
      includeSection('showcase') ? app.prisma.resource.count({ where: resourceWhere('showcase') }) : 0,
      includeSection('multimedia') ? app.prisma.resource.findMany({ where: resourceWhere('multimedia'), ...window, orderBy: [{ resourceDate: 'desc' }, { createdAt: 'desc' }], include: resourceInclude }) : [],
      includeSection('multimedia') ? app.prisma.resource.count({ where: resourceWhere('multimedia') }) : 0,
    ]);
    const editionItem = (edition: (typeof magazines)[number] | (typeof books)[number]) => ({
      id: edition.id,
      slug: edition.slug,
      kind: edition.kind.toLowerCase(),
      number: edition.number,
      title: edition.title,
      subtitle: edition.subtitle,
      author: edition.author,
      date: edition.dateLabel,
      theme: edition.theme,
      summary: edition.summary,
      cover: edition.coverResource ? { url: edition.coverResource.url, alt: edition.coverResource.alt } : null,
      tags: unique(edition.notes.flatMap(note => note.categories.map(item => item.category.name))),
    });
    const resourceItem = (resource: (typeof showcase)[number] | (typeof multimedia)[number]) => ({
      ...serializeResource(resource),
      tags: unique(resource.notes.flatMap(item => item.note.categories.map(category => category.category.name))),
      notes: resource.notes.map(item => ({ slug: item.note.slug, title: item.note.title, role: item.role })),
      editions: resource.editions.map(item => ({ slug: item.edition.slug, title: item.edition.title, kind: item.edition.kind.toLowerCase(), role: item.role })),
    });
    return {
      magazines: magazines.map(editionItem),
      books: books.map(editionItem),
      showcase: showcase.map(resourceItem),
      multimedia: multimedia.map(resourceItem),
      pagination: {
        magazines: paginationMeta(query.page, query.pageSize, magazineTotal),
        books: paginationMeta(query.page, query.pageSize, bookTotal),
        showcase: paginationMeta(query.page, query.pageSize, showcaseTotal),
        multimedia: paginationMeta(query.page, query.pageSize, multimediaTotal),
      },
      filters: { section: query.section, search: query.search ?? null, tag: query.tag ?? null, type: query.type ?? null },
    };
  });

  app.get('/resources', async request => {
    const query = parse(z.object({
      types: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(12),
    }), request.query);
    const acceptedTypes = ['IMAGE', 'VIDEO', 'AUDIO', 'PDF', 'LINK'] as const;
    const types = query.types
      ? [...new Set(query.types.split(',').map(value => value.trim().toUpperCase()).filter((value): value is typeof acceptedTypes[number] => acceptedTypes.includes(value as typeof acceptedTypes[number])))]
      : [];
    if (query.types && !types.length) throw new AppError(400, 'INVALID_RESOURCE_TYPE', 'Indicá al menos un tipo de recurso válido.');
    const where = {
      status: 'PUBLISHED' as const,
      uploadStatus: 'COMPLETE' as const,
      ...(types.length ? { type: { in: types } } : {}),
    };
    const [items, total] = await app.prisma.$transaction([
      app.prisma.resource.findMany({ where, orderBy: [{ resourceDate: 'desc' }, { createdAt: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      app.prisma.resource.count({ where }),
    ]);
    return {
      items: items.map(serializeResource),
      pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) },
    };
  });

  app.get('/editions/:slug/home', async request => {
    const { slug } = parse(z.object({ slug: z.string().min(1).max(160) }), request.params);
    const edition = await app.prisma.edition.findFirst({
      where: { slug, status: 'PUBLISHED' },
      include: {
        coverResource: true,
        notes: {
          where: { status: 'PUBLISHED' },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            categories: { include: { category: true } },
            resources: { include: { resource: true } },
            ratings: { select: { score: true } },
          },
        },
      },
    });
    if (!edition) throw new AppError(404, 'EDITION_NOT_FOUND', 'No encontramos esa edición publicada.');
    return {
      edition: {
        id: edition.id,
        slug: edition.slug,
        number: edition.number == null ? '' : `Nº ${String(edition.number).padStart(2, '0')}`,
        title: edition.title,
        subtitle: edition.subtitle,
        theme: edition.theme,
        date: edition.dateLabel,
        publication: edition.publication,
        headerLine: edition.headerLine,
      },
      masthead: {
        image: edition.coverResource?.url ?? '',
        alt: edition.coverResource?.alt ?? `Portada de ${edition.title}`,
      },
      notes: edition.notes.map(serializePublicNote),
    };
  });

  app.get('/notes/:noteId', async request => {
    const { noteId } = parse(idParams, request.params);
    const note = await app.prisma.note.findFirst({
      where: { ...noteWhere(noteId), status: 'PUBLISHED' },
      include: {
        categories: { include: { category: true } },
        resources: { include: { resource: true } },
        ratings: { select: { score: true } },
      },
    });
    if (!note) throw new AppError(404, 'NOTE_NOT_FOUND', 'No encontramos esa nota publicada.');
    return serializePublicNote(note);
  });

  app.get('/notes/:noteId/comments', async request => {
    const { noteId } = parse(idParams, request.params);
    const note = await findNote(app.prisma, noteId);
    if (!note || note.status !== 'PUBLISHED') throw new AppError(404, 'NOTE_NOT_FOUND', 'No encontramos esa nota publicada.');
    const comments = await app.prisma.comment.findMany({
      where: { noteId: note.id, status: 'VISIBLE' },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: { _count: { select: { votes: true } } },
    });
    return comments.map(serializeComment);
  });

  app.post('/notes/:noteId/comments', { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const { noteId } = parse(idParams, request.params);
    const input = parse(z.object({
      author: z.string().trim().min(1).max(80).optional(),
      body: z.string().trim().min(3).max(2_000),
    }), request.body);
    const note = await findNote(app.prisma, noteId);
    if (!note || note.status !== 'PUBLISHED') throw new AppError(404, 'NOTE_NOT_FOUND', 'No encontramos esa nota publicada.');
    const comment = await app.prisma.comment.create({
      data: {
        noteId: note.id,
        userId: request.auth?.user.id,
        authorName: request.auth?.user.displayName ?? input.author ?? 'Anónima',
        body: input.body,
        status: 'PENDING',
      },
      include: { _count: { select: { votes: true } } },
    });
    return reply.code(201).send({ ...serializeComment(comment), moderationMessage: 'El comentario quedó pendiente de moderación.' });
  });

  app.post('/notes/:noteId/comments/:commentId/upvote', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { noteId, commentId } = parse(z.object({ noteId: z.string().min(1).max(100), commentId: z.string().uuid() }), request.params);
    const note = await findNote(app.prisma, noteId);
    if (!note) throw new AppError(404, 'NOTE_NOT_FOUND', 'No encontramos esa nota.');
    const comment = await app.prisma.comment.findFirst({ where: { id: commentId, noteId: note.id, status: 'VISIBLE' } });
    if (!comment) throw new AppError(404, 'COMMENT_NOT_FOUND', 'No encontramos ese comentario publicado.');
    const identity = voterIdentity(request, reply);
    try {
      await app.prisma.commentVote.create({ data: { commentId, voterKey: identity.voterKey, userId: identity.userId } });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    }
    const updated = await app.prisma.comment.findUniqueOrThrow({ where: { id: commentId }, include: { _count: { select: { votes: true } } } });
    return serializeComment(updated);
  });

  app.post('/notes/:noteId/comments/:commentId/report', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (request, reply) => {
    const { noteId, commentId } = parse(z.object({ noteId: z.string().min(1).max(100), commentId: z.string().uuid() }), request.params);
    const input = parse(z.object({ reason: z.enum(['spam', 'abuse', 'privacy', 'other']), detail: z.string().trim().max(500).optional() }), request.body);
    const note = await findNote(app.prisma, noteId);
    const comment = note ? await app.prisma.comment.findFirst({ where: { id: commentId, noteId: note.id } }) : null;
    if (!comment) throw new AppError(404, 'COMMENT_NOT_FOUND', 'No encontramos ese comentario.');
    const identity = voterIdentity(request, reply);
    try {
      await app.prisma.$transaction([
        app.prisma.commentReport.create({ data: { commentId, reporterId: identity.userId, reporterKey: identity.voterKey, reason: input.reason, detail: input.detail } }),
        app.prisma.comment.update({ where: { id: commentId }, data: { reportCount: { increment: 1 }, status: comment.status === 'VISIBLE' ? 'REPORTED' : comment.status } }),
      ]);
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
    }
    return reply.code(202).send({ message: 'Recibimos el reporte para moderación.' });
  });

  app.post('/notes/:noteId/rating', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { noteId } = parse(idParams, request.params);
    const { score } = parse(z.object({ score: z.number().int().min(1).max(5) }), request.body);
    const note = await findNote(app.prisma, noteId);
    if (!note || note.status !== 'PUBLISHED') throw new AppError(404, 'NOTE_NOT_FOUND', 'No encontramos esa nota publicada.');
    const identity = voterIdentity(request, reply);
    await app.prisma.noteRating.upsert({
      where: { noteId_voterKey: { noteId: note.id, voterKey: identity.voterKey } },
      create: { noteId: note.id, voterKey: identity.voterKey, userId: identity.userId, score },
      update: { score, userId: identity.userId },
    });
    const aggregate = await app.prisma.noteRating.aggregate({ where: { noteId: note.id }, _avg: { score: true }, _count: { score: true } });
    return { rating: Number((aggregate._avg.score ?? 0).toFixed(1)), ratingsCount: aggregate._count.score };
  });

  app.post('/contacts', { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const input = parse(z.object({
      name: z.string().trim().min(2).max(100),
      email: z.string().trim().toLowerCase().email().max(254),
      subject: z.string().trim().min(3).max(160).default('Mensaje desde el sitio'),
      body: z.string().trim().min(10).max(10_000),
    }), request.body);
    const contact = await app.prisma.contactMessage.create({ data: input });
    return reply.code(201).send({ id: contact.id, status: 'new', message: 'El mensaje llegó a la bandeja editorial.' });
  });

  app.post('/analytics/events', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    if (request.headers['sec-gpc'] === '1' || request.headers.dnt === '1') return reply.code(202).send({ accepted: 0, privacySignalRespected: true });
    const input = parse(z.object({
      sessionId: z.string().min(16).max(100),
      events: z.array(z.object({
        type: z.enum(['page_view', 'reading_started', 'reading_completed', 'reading_time', 'attention', 'download', 'referral']),
        noteId: z.string().max(100).optional(),
        editionSlug: z.string().max(160).optional(),
        resourceId: z.string().uuid().optional(),
        segment: z.string().max(60).optional(),
        source: z.string().max(500).optional(),
        durationSeconds: z.number().int().min(0).max(86_400).optional(),
        progressPercent: z.number().int().min(0).max(100).optional(),
        occurredAt: z.string().datetime().optional(),
      })).min(1).max(20),
    }), request.body);
    const day = new Date().toISOString().slice(0, 10);
    const sessionHash = hmacSha256(app.config.analyticsHmacSecret, `${day}:${input.sessionId}`);
    const typeMap = {
      page_view: 'PAGE_VIEW', reading_started: 'READING_STARTED', reading_completed: 'READING_COMPLETED',
      reading_time: 'READING_TIME', attention: 'ATTENTION', download: 'DOWNLOAD', referral: 'REFERRAL',
    } as const;
    const rows = [];
    for (const event of input.events) {
      const note = event.noteId ? await findNote(app.prisma, event.noteId) : null;
      const edition = event.editionSlug ? await app.prisma.edition.findUnique({ where: { slug: event.editionSlug }, select: { id: true } }) : null;
      rows.push({
        type: typeMap[event.type], sessionHash, noteId: note?.id, editionId: edition?.id, resourceId: event.resourceId,
        segment: event.segment, sourceCategory: classifySource(event.source), durationSeconds: event.durationSeconds,
        progressPercent: event.progressPercent, occurredAt: event.occurredAt ? new Date(event.occurredAt) : new Date(),
      });
    }
    await app.prisma.analyticsEvent.createMany({ data: rows });
    return reply.code(202).send({ accepted: rows.length });
  });
};

function classifySource(source?: string) {
  if (!source) return 'direct';
  const normalized = source.toLowerCase();
  if (/google|bing|duckduckgo|yahoo/.test(normalized)) return 'search';
  if (/instagram|facebook|twitter|x\.com|youtube|tiktok|mastodon/.test(normalized)) return 'social';
  return 'referral';
}

function unique(values: string[]) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'es'));
}
