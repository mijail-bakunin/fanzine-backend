import type { FastifyPluginAsync } from 'fastify';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { hmacSha256 } from '../../lib/crypto.js';
import { paginationMeta, pageWindow } from '../../lib/pagination.js';
import { parse } from '../../lib/validation.js';
import { voterIdentity } from '../auth/auth-context.js';
import { findNote, noteWhere } from './note-lookup.js';
import { serializeComment, serializePublicNote, serializeResource, serializeSiteSettings } from './serializers.js';
import { serializeCoverArt } from './edition-cover-art.js';
import { asRecord, localizedRecord, localizedString, publicLocaleSchema, resolveEditorialTranslation } from './localization.js';
import { buildEditionPdf } from './edition-pdf.js';
import { createInFlightDeduplicator } from '../../lib/in-flight.js';
import { COVER_CANVAS } from './cover-composition.js';

const idParams = z.object({ noteId: z.string().trim().min(1).max(100) });
const commentParams = z.object({ noteId: z.string().trim().min(1).max(100), commentId: z.string().uuid() });
const commentBody = z.object({
  author: z.string().trim().min(1).max(80).optional(),
  body: z.string().trim().min(3).max(2_000),
});

export const publicContentRoutes: FastifyPluginAsync = async app => {
  const deduplicatePublicRead = createInFlightDeduplicator();
  const readEditionHome = (slug: string, locale: z.infer<typeof publicLocaleSchema>) =>
    deduplicatePublicRead(`edition-home:${slug}:${locale}`, () => editionHome(app.prisma, slug, locale));

  app.get('/site/settings', async request => {
    const { locale } = parse(z.object({ locale: publicLocaleSchema }), request.query);
    return deduplicatePublicRead(`site-settings:${locale}`, async () => {
      const settings = await app.prisma.siteSettings.findUnique({ where: { id: 'default' } });
      if (!settings) throw new AppError(503, 'SITE_SETTINGS_NOT_CONFIGURED', 'La configuración editorial todavía no está disponible.');
      return serializeSiteSettings(settings, locale);
    });
  });

  app.get('/editions', async request => {
    const query = parse(z.object({
      kind: z.enum(['magazine', 'book']).default('magazine'),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(12),
      locale: publicLocaleSchema,
    }), request.query);
    const where = { kind: query.kind.toUpperCase() as 'MAGAZINE' | 'BOOK', status: 'PUBLISHED' as const };
    const [items, total] = await app.prisma.$transaction([
      app.prisma.edition.findMany({ where, orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      app.prisma.edition.count({ where }),
    ]);
    return {
      items: items.map(edition => {
        const localized = resolveEditorialTranslation(edition.localizedContent, query.locale).record;
        return ({
        id: edition.id, slug: edition.slug, kind: edition.kind.toLowerCase(), number: edition.number,
        title: localizedString(localized, 'title', edition.title), subtitle: localizedString(localized, 'subtitle', edition.subtitle),
        author: localizedString(localized, 'author', edition.author), date: localizedString(localized, 'dateLabel', edition.dateLabel),
        theme: localizedString(localized, 'theme', edition.theme), summary: localizedString(localized, 'summary', edition.summary),
        coverArt: serializeCoverArt(edition.coverArt),
      }); }),
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
      locale: publicLocaleSchema,
    }), request.query);
    return deduplicatePublicRead(`catalog:${JSON.stringify(query)}`, async () => {
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
        select: { categories: { select: { category: { select: { slug: true, name: true, localizedContent: true } } } } },
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
              localizedContent: true,
              categories: { select: { category: { select: { slug: true, name: true, localizedContent: true } } } },
            },
          },
        },
      },
      editions: {
        where: { edition: { status: 'PUBLISHED' as const } },
        select: { role: true, edition: { select: { slug: true, title: true, kind: true, localizedContent: true } } },
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
    const editionItem = (edition: (typeof magazines)[number] | (typeof books)[number]) => {
      const localized = resolveEditorialTranslation(edition.localizedContent, query.locale).record;
      return ({
      id: edition.id,
      slug: edition.slug,
      kind: edition.kind.toLowerCase(),
      number: edition.number,
      title: localizedString(localized, 'title', edition.title),
      subtitle: localizedString(localized, 'subtitle', edition.subtitle),
      author: localizedString(localized, 'author', edition.author),
      date: localizedString(localized, 'dateLabel', edition.dateLabel),
      theme: localizedString(localized, 'theme', edition.theme),
      summary: localizedString(localized, 'summary', edition.summary),
      coverArt: serializeCoverArt(edition.coverArt),
      cover: edition.coverResource?.status === 'PUBLISHED' && edition.coverResource.uploadStatus === 'COMPLETE'
        ? (() => { const cover = serializeResource(edition.coverResource, query.locale); return { url: cover.url, alt: cover.alt }; })()
        : null,
      tags: unique(edition.notes.flatMap(note => note.categories.map(item => localizedString(resolveEditorialTranslation(item.category.localizedContent, query.locale).record, 'name', item.category.name)!))),
    }); };
    const resourceItem = (resource: (typeof showcase)[number] | (typeof multimedia)[number]) => ({
      ...serializeResource(resource, query.locale),
      tags: unique(resource.notes.flatMap(item => item.note.categories.map(category => localizedString(resolveEditorialTranslation(category.category.localizedContent, query.locale).record, 'name', category.category.name)!))),
      notes: resource.notes.map(item => ({
        slug: item.note.slug,
        title: localizedString(resolveEditorialTranslation(item.note.localizedContent, query.locale).record, 'title', item.note.title),
        role: item.role,
      })),
      editions: resource.editions.map(item => ({
        slug: item.edition.slug,
        title: localizedString(resolveEditorialTranslation(item.edition.localizedContent, query.locale).record, 'title', item.edition.title),
        kind: item.edition.kind.toLowerCase(), role: item.role,
      })),
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
  });

  app.get('/resources', async request => {
    const query = parse(z.object({
      types: z.string().trim().max(120).optional(),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(12),
      locale: publicLocaleSchema,
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
      items: items.map(item => serializeResource(item, query.locale)),
      pagination: { page: query.page, pageSize: query.pageSize, total, totalPages: Math.max(1, Math.ceil(total / query.pageSize)) },
    };
  });

  app.get('/search', async request => {
    const query = parse(z.object({
      q: z.string().trim().min(2).max(120),
      locale: publicLocaleSchema,
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(12),
    }), request.query);
    return deduplicatePublicRead(`search:${JSON.stringify(query)}`, async () => {
    const contains = { contains: query.q, mode: 'insensitive' as const };
    const take = Math.min(1_000, query.page * query.pageSize);
    const localizedPath = (key: string) => ({ path: [query.locale, key], string_contains: query.q, mode: 'insensitive' as const });
    const publishedTranslation = (key: string) => ({ AND: [
      { OR: [
        { localizedContent: { path: [query.locale, 'status'], equals: 'published' } },
        { localizedContent: { path: [query.locale, 'status'], equals: Prisma.AnyNull } },
      ] },
      { localizedContent: localizedPath(key) },
    ] });
    const [notes, noteTotal, editions, editionTotal, resources, resourceTotal] = await Promise.all([
      app.prisma.note.findMany({
        where: { status: 'PUBLISHED', OR: [{ title: contains }, { excerpt: contains }, { bodyMarkdown: contains }, { authorName: contains },
          publishedTranslation('title'), publishedTranslation('excerpt'), publishedTranslation('bodyMarkdown')] },
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }], take,
        include: {
          edition: { select: { slug: true } },
          categories: { include: { category: true } },
          resources: { where: { resource: { type: 'IMAGE', status: 'PUBLISHED', uploadStatus: 'COMPLETE' } }, orderBy: { sortOrder: 'asc' }, take: 1, include: { resource: true } },
        },
      }),
      app.prisma.note.count({ where: { status: 'PUBLISHED', OR: [{ title: contains }, { excerpt: contains }, { bodyMarkdown: contains }, { authorName: contains },
        publishedTranslation('title'), publishedTranslation('excerpt'), publishedTranslation('bodyMarkdown')] } }),
      app.prisma.edition.findMany({
        where: { status: 'PUBLISHED', OR: [{ title: contains }, { subtitle: contains }, { summary: contains }, { theme: contains }, { author: contains },
          publishedTranslation('title'), publishedTranslation('subtitle'), publishedTranslation('summary')] },
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }], take,
        include: { coverResource: true, notes: { where: { status: 'PUBLISHED' }, select: { categories: { include: { category: true } } } } },
      }),
      app.prisma.edition.count({ where: { status: 'PUBLISHED', OR: [{ title: contains }, { subtitle: contains }, { summary: contains }, { theme: contains }, { author: contains },
        publishedTranslation('title'), publishedTranslation('subtitle'), publishedTranslation('summary')] } }),
      app.prisma.resource.findMany({
        where: { status: 'PUBLISHED', uploadStatus: 'COMPLETE', OR: [{ name: contains }, { alt: contains }, { credit: contains }, { license: contains },
          publishedTranslation('name'), publishedTranslation('alt')] },
        orderBy: [{ resourceDate: 'desc' }, { createdAt: 'desc' }], take,
        include: {
          notes: { where: { note: { status: 'PUBLISHED' } }, take: 1, include: { note: { include: { edition: { select: { slug: true } }, categories: { include: { category: true } } } } } },
          editions: { where: { edition: { status: 'PUBLISHED' } }, take: 1, include: { edition: { select: { slug: true } } } },
        },
      }),
      app.prisma.resource.count({ where: { status: 'PUBLISHED', uploadStatus: 'COMPLETE', OR: [{ name: contains }, { alt: contains }, { credit: contains }, { license: contains },
        publishedTranslation('name'), publishedTranslation('alt')] } }),
    ]);
    const results = [
      ...notes.map(note => {
        const localized = resolveEditorialTranslation(note.localizedContent, query.locale).record;
        const editionSlug = note.edition?.slug ?? null;
        const image = note.resources[0]?.resource;
        return {
          id: note.id, slug: note.slug, type: 'note' as const, title: localizedString(localized, 'title', note.title)!,
          description: localizedString(localized, 'excerpt', note.excerpt)!,
          tags: unique(note.categories.map(item => localizedString(resolveEditorialTranslation(item.category.localizedContent, query.locale).record, 'name', item.category.name)!)),
          route: editionSlug ? `/edicion/${editionSlug}/nota/${note.slug}` : `/nota/${note.slug}`, editionSlug,
          image: image ? (() => { const serialized = serializeResource(image, query.locale); return { url: serialized.url, alt: serialized.alt }; })() : null,
          publishedAt: note.publishedAt ?? note.createdAt,
        };
      }),
      ...editions.map(edition => {
        const localized = resolveEditorialTranslation(edition.localizedContent, query.locale).record;
        const cover = edition.coverResource?.status === 'PUBLISHED' && edition.coverResource.uploadStatus === 'COMPLETE' ? edition.coverResource : null;
        return {
          id: edition.id, slug: edition.slug, type: edition.kind === 'BOOK' ? 'book' as const : 'edition' as const,
          title: localizedString(localized, 'title', edition.title)!,
          description: localizedString(localized, 'summary', edition.summary ?? edition.subtitle ?? edition.theme ?? '')!,
          tags: unique(edition.notes.flatMap(note => note.categories.map(item => localizedString(resolveEditorialTranslation(item.category.localizedContent, query.locale).record, 'name', item.category.name)!))), route: `/edicion/${edition.slug}`,
          editionSlug: edition.slug,
          image: cover ? (() => { const serialized = serializeResource(cover, query.locale); return { url: serialized.url, alt: serialized.alt }; })() : null,
          publishedAt: edition.publishedAt ?? edition.createdAt,
        };
      }),
      ...resources.map(resource => {
        const localized = resolveEditorialTranslation(resource.localizedContent, query.locale).record;
        const linkedNote = resource.notes[0]?.note;
        const editionSlug = linkedNote?.edition?.slug ?? resource.editions[0]?.edition.slug ?? null;
        return {
          id: resource.id, slug: null, type: resource.type.toLowerCase(), title: localizedString(localized, 'name', resource.name)!,
          description: localizedString(localized, 'alt', resource.alt)!,
          tags: unique(linkedNote?.categories.map(item => localizedString(resolveEditorialTranslation(item.category.localizedContent, query.locale).record, 'name', item.category.name)!) ?? []), route: '/archivo', editionSlug,
          image: resource.type === 'IMAGE' ? { url: resource.url, alt: localizedString(localized, 'alt', resource.alt)! } : null,
          publishedAt: resource.resourceDate,
        };
      }),
    ].sort((left, right) => right.publishedAt.getTime() - left.publishedAt.getTime());
    const start = (query.page - 1) * query.pageSize;
    const items = results.slice(start, start + query.pageSize).map(({ publishedAt: _publishedAt, ...item }) => item);
    return {
      items,
      groups: {
        notes: items.filter(item => item.type === 'note'),
        editions: items.filter(item => item.type === 'edition' || item.type === 'book'),
        resources: items.filter(item => !['note', 'edition', 'book'].includes(item.type)),
      },
      pagination: paginationMeta(query.page, query.pageSize, noteTotal + editionTotal + resourceTotal),
      filters: { q: query.q, locale: query.locale },
    };
    });
  });

  app.get('/editions/:slug/home', async request => {
    const { slug } = parse(z.object({ slug: z.string().min(1).max(160) }), request.params);
    const { locale } = parse(z.object({ locale: publicLocaleSchema }), request.query);
    return readEditionHome(slug, locale);
  });

  app.get('/editions/current/home', async request => {
    const { locale } = parse(z.object({ locale: publicLocaleSchema }), request.query);
    return deduplicatePublicRead(`current-edition-home:${locale}`, async () => {
      const current = await app.prisma.edition.findFirst({
        where: { kind: 'MAGAZINE', status: 'PUBLISHED' },
        orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }], select: { slug: true },
      });
      if (!current) throw new AppError(404, 'CURRENT_EDITION_NOT_FOUND', 'Todavía no hay una edición vigente publicada.');
      return readEditionHome(current.slug, locale);
    });
  });

  app.get('/editions/:slug/pdf', async (request, reply) => {
    const { slug } = parse(z.object({ slug: z.string().min(1).max(160) }), request.params);
    const { locale } = parse(z.object({ locale: publicLocaleSchema }), request.query);
    const pdf = await buildEditionPdf(app.prisma, app.config, slug, locale);
    reply.header('Content-Type', 'application/pdf');
    reply.header('Content-Disposition', `attachment; filename="${pdf.fileName}"`);
    reply.header('Content-Length', String(pdf.buffer.length));
    reply.header('Cache-Control', 'public, max-age=300, must-revalidate');
    return reply.send(pdf.buffer);
  });

  app.get('/notes/:noteId', async request => {
    const { noteId } = parse(idParams, request.params);
    const { locale } = parse(z.object({ locale: publicLocaleSchema }), request.query);
    const note = await app.prisma.note.findFirst({
      where: { ...noteWhere(noteId), status: 'PUBLISHED' },
      include: {
        categories: { include: { category: true } },
        resources: {
          where: { resource: { status: 'PUBLISHED', uploadStatus: 'COMPLETE' } },
          include: { resource: true },
        },
        ratings: { select: { score: true } },
      },
    });
    if (!note) throw new AppError(404, 'NOTE_NOT_FOUND', 'No encontramos esa nota publicada.');
    return serializePublicNote(note, locale);
  });

  app.get('/notes/:noteId/comments', async request => {
    const { noteId } = parse(idParams, request.params);
    const note = await findNote(app.prisma, noteId);
    if (!note || note.status !== 'PUBLISHED') throw new AppError(404, 'NOTE_NOT_FOUND', 'No encontramos esa nota publicada.');
    const comments = await app.prisma.comment.findMany({
      where: {
        noteId: note.id,
        OR: [
          { status: { in: ['VISIBLE', 'PENDING'] } },
          { status: 'DELETED', userId: null },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
      include: { _count: { select: { votes: true } } },
    });
    const roots = comments.filter(comment => comment.parentId === null);
    const replies = comments.filter(comment => comment.parentId !== null);
    return roots.map(comment => serializeComment({ ...comment, replies: replies.filter(reply => reply.parentId === comment.id) }));
  });

  app.post('/notes/:noteId/comments', { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const { noteId } = parse(idParams, request.params);
    const input = parse(commentBody, request.body);
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

  app.post('/notes/:noteId/comments/:commentId/replies', { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const { noteId, commentId } = parse(commentParams, request.params);
    const input = parse(commentBody, request.body);
    const note = await findNote(app.prisma, noteId);
    if (!note || note.status !== 'PUBLISHED') throw new AppError(404, 'NOTE_NOT_FOUND', 'No encontramos esa nota publicada.');
    const parent = await app.prisma.comment.findFirst({ where: { id: commentId, noteId: note.id, status: 'VISIBLE' } });
    if (!parent) throw new AppError(404, 'COMMENT_NOT_FOUND', 'No encontramos ese comentario publicado.');
    if (parent.parentId) throw new AppError(409, 'COMMENT_REPLY_DEPTH_EXCEEDED', 'Las respuestas sólo pueden depender de un comentario principal.');
    const comment = await app.prisma.comment.create({
      data: {
        noteId: note.id,
        parentId: parent.id,
        userId: request.auth?.user.id,
        authorName: request.auth?.user.displayName ?? input.author ?? 'Anónima',
        body: input.body,
        status: 'PENDING',
      },
      include: { _count: { select: { votes: true } } },
    });
    return reply.code(201).send({ ...serializeComment(comment), moderationMessage: 'La respuesta quedó pendiente de moderación.' });
  });

  app.post('/notes/:noteId/comments/:commentId/reactions', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { noteId, commentId } = parse(commentParams, request.params);
    const { reaction } = parse(z.object({ reaction: z.literal('like') }), request.body);
    const note = await findNote(app.prisma, noteId);
    if (!note || note.status !== 'PUBLISHED') throw new AppError(404, 'NOTE_NOT_FOUND', 'No encontramos esa nota publicada.');
    const comment = await app.prisma.comment.findFirst({ where: { id: commentId, noteId: note.id, status: 'VISIBLE' } });
    if (!comment) throw new AppError(404, 'COMMENT_NOT_FOUND', 'No encontramos ese comentario publicado.');
    const identity = voterIdentity(request, reply);
    const reacted = await app.prisma.$transaction(async tx => {
      const existing = await tx.commentVote.findUnique({ where: { commentId_voterKey: { commentId, voterKey: identity.voterKey } } });
      if (existing) {
        await tx.commentVote.delete({ where: { id: existing.id } });
        return false;
      }
      await tx.commentVote.create({ data: { commentId, voterKey: identity.voterKey, userId: identity.userId } });
      return true;
    });
    const updated = await app.prisma.comment.findUniqueOrThrow({ where: { id: commentId }, include: { _count: { select: { votes: true } } } });
    return { ...serializeComment(updated), reaction: reacted ? reaction : null, reacted };
  });

  app.post('/notes/:noteId/comments/:commentId/upvote', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { noteId, commentId } = parse(commentParams, request.params);
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
    return serializeRatingAggregate(aggregate._avg.score, aggregate._count.score);
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

async function editionHome(prisma: PrismaClient, slug: string, locale: z.infer<typeof publicLocaleSchema>) {
  const edition = await prisma.edition.findFirst({
    where: { slug, status: 'PUBLISHED' },
    include: {
      coverResource: true,
      notes: {
        where: { status: 'PUBLISHED' },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: {
          categories: { include: { category: true } },
          resources: {
            where: { resource: { status: 'PUBLISHED', uploadStatus: 'COMPLETE' } },
            include: { resource: true },
          },
          ratings: { select: { score: true } },
        },
      },
    },
  });
  if (!edition) throw new AppError(404, 'EDITION_NOT_FOUND', 'No encontramos esa edición publicada.');
  const resolvedEdition = resolveEditorialTranslation(edition.localizedContent, locale);
  const localizedEdition = resolvedEdition.record;
  const cover = edition.coverResource?.status === 'PUBLISHED' && edition.coverResource.uploadStatus === 'COMPLETE'
    ? serializeResource(edition.coverResource, locale)
    : null;
  const mastheadTranslation = asRecord(localizedEdition.masthead);
  const translatedMastheadImage = localizedString(mastheadTranslation, 'image', null);
  const translatedMastheadAlt = localizedString(mastheadTranslation, 'alt', null);
  const mastheadImage = translatedMastheadImage ?? cover?.url ?? '';
  const referenceImage = localizedString(mastheadTranslation, 'referenceImage', mastheadImage)!;
  return {
    requestedLocale: resolvedEdition.requestedLocale,
    locale: resolvedEdition.locale,
    translationFallback: resolvedEdition.translationFallback,
    edition: {
      id: edition.id, slug: edition.slug, number: edition.number,
      title: localizedString(localizedEdition, 'title', edition.title),
      subtitle: localizedString(localizedEdition, 'subtitle', edition.subtitle),
      theme: localizedString(localizedEdition, 'theme', edition.theme),
      summary: localizedString(localizedEdition, 'summary', edition.summary),
      date: localizedString(localizedEdition, 'dateLabel', edition.dateLabel),
      publication: localizedString(localizedEdition, 'publication', edition.publication),
      headerLine: localizedString(localizedEdition, 'headerLine', edition.headerLine),
      coverArt: serializeCoverArt(edition.coverArt),
    },
    masthead: {
      image: mastheadImage,
      referenceImage,
      alt: translatedMastheadAlt ?? cover?.alt ?? '',
      canvas: { ...COVER_CANVAS },
      requestedLocale: resolvedEdition.requestedLocale,
      locale: resolvedEdition.locale,
      translationFallback: resolvedEdition.translationFallback,
    },
    notes: edition.notes.map(note => serializePublicNote(note, locale)),
  };
}

export function serializeRatingAggregate(average: number | null, count: number) {
  return { rating: Number((average ?? 0).toFixed(1)), ratingsCount: count };
}
