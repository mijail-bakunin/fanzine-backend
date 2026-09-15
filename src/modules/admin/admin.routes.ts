import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Prisma, type EditorialStatus, type PrismaClient, type UserRole } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { paginationSchema } from '../../lib/pagination.js';
import { slugify } from '../../lib/slug.js';
import { parse } from '../../lib/validation.js';
import { sendCommentRemoval, sendContactReply } from '../../services/mailer.js';
import { requireCsrf, requireRole } from '../auth/auth-context.js';
import { serializeCoverMetadata, serializeResource, serializeSiteSettings } from '../content/serializers.js';
import { COVER_CANVAS, coverRectangleErrors, resolveCoverRectangle, serializeCoverComposition } from '../content/cover-composition.js';
import { coverArtPatchSchema, coverArtSchema, DEFAULT_COVER_ART, mergeCoverArt, serializeCoverArt } from '../content/edition-cover-art.js';
import { coverTypographyPatchSchema, coverTypographySchema, DEFAULT_COVER_TYPOGRAPHY, mergeCoverTypography, serializeCoverTypography } from '../content/note-cover-typography.js';
import {
  asRecord, categoryTranslationSchema, contentByLocaleSchema, editionTranslationSchema, mergeTranslationRecords,
  noteTranslationSchema, resourceTranslationSchema, seoByLocaleSchema, translationStatuses, translationsSchema,
} from '../content/localization.js';
import { audit } from './audit.js';
import { DEFAULT_COMMENT_REMOVAL_REASON, safeModerationMailError, serializeCommentEmailDelivery } from './comment-moderation.js';
import { getDashboard } from './dashboard.service.js';

const editorialStatusSchema = z.enum(['draft', 'review', 'scheduled', 'published', 'archived', 'deleted']);
const dashboardStatusSchema = z.enum(['draft', 'review', 'scheduled', 'published', 'archived', 'deleted', 'pending', 'visible', 'hidden', 'reported']);
const uuidParams = z.object({ id: z.string().uuid() });
const optionalText = (max: number) => z.string().trim().max(max).optional();
const httpUrl = z.string().url().max(2_000).refine(value => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, 'La URL debe usar el protocolo HTTP o HTTPS.');
const idListSchema = z.array(z.string().min(1).max(100)).max(500);
const idList = idListSchema.default([]);
const staffRoles: UserRole[] = ['ADMIN', 'EDITOR', 'MODERATOR'];
const editorialRoles: UserRole[] = ['ADMIN', 'EDITOR'];
const moderationRoles: UserRole[] = ['ADMIN', 'MODERATOR'];
const allowRoles = (roles: UserRole[]) => async (request: FastifyRequest) => { requireRole(request, roles); };
const allowEditorial = allowRoles(editorialRoles);
const allowModeration = allowRoles(moderationRoles);
const allowAdmin = allowRoles(['ADMIN']);
const editionTranslationsSchema = translationsSchema(editionTranslationSchema);
const noteTranslationsSchema = translationsSchema(noteTranslationSchema);
const resourceTranslationsSchema = translationsSchema(resourceTranslationSchema);
const categoryTranslationsSchema = translationsSchema(categoryTranslationSchema);

export const adminRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', async request => {
    requireRole(request, staffRoles);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) requireCsrf(request);
  });

  app.get('/admin/dashboard', async request => {
    const query = parse(paginationSchema.extend({
      section: z.enum(['all', 'editions', 'notes', 'resources', 'categories', 'contacts', 'comments', 'users', 'logs', 'analytics']).default('all'),
      status: dashboardStatusSchema.optional(),
      search: z.string().trim().max(120).optional(),
      from: z.string().datetime().optional(),
    }), request.query);
    assertDashboardSection(request.auth!.user.role, query.section);
    const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000);
    return getDashboard(app.prisma, {
      page: query.page,
      pageSize: query.pageSize,
      section: query.section,
      role: request.auth!.user.role,
      status: query.status,
      search: query.search,
      from,
    });
  });

  app.get('/admin/settings', { preHandler: allowEditorial }, async () => {
    const settings = await app.prisma.siteSettings.findUnique({ where: { id: 'default' } });
    if (!settings) throw new AppError(503, 'SITE_SETTINGS_NOT_CONFIGURED', 'Ejecutá el seed o cargá la configuración editorial.');
    return serializeSiteSettings(settings, 'es', true);
  });

  app.patch('/admin/settings', { preHandler: allowEditorial }, async request => {
    const input = parse(siteSettingsSchema.partial().refine(value => Object.keys(value).length > 0, 'El cambio no puede estar vacío.'), request.body);
    const existing = await app.prisma.siteSettings.findUnique({ where: { id: 'default' } });
    if (!existing) throw new AppError(503, 'SITE_SETTINGS_NOT_CONFIGURED', 'Ejecutá el seed antes de editar la configuración editorial.');
    const settings = await app.prisma.siteSettings.update({ where: { id: 'default' }, data: {
      brandName: input.brandName,
      publicationType: input.publicationType,
      statement: input.statement,
      headerLine: input.headerLine,
      navigation: input.navigation as Prisma.InputJsonValue | undefined,
      footerStatement: input.footerStatement,
      socialPrompt: input.socialPrompt,
      socialLinks: input.socialLinks as Prisma.InputJsonValue | undefined,
      contentByLocale: input.contentByLocale as Prisma.InputJsonValue | undefined,
      seoByLocale: input.seoByLocale as Prisma.InputJsonValue | undefined,
    } });
    await audit(request, { action: 'Actualizó la configuración editorial pública.', entityType: 'site_settings', entityId: settings.id });
    return serializeSiteSettings(settings, 'es', true);
  });

  app.post('/admin/editions', { preHandler: allowEditorial }, async (request, reply) => {
    const input = parse(z.object({
      title: z.string().trim().min(2).max(180),
      slug: optionalText(180),
      subtitle: optionalText(240).default(''),
      date: z.string().trim().min(2).max(80),
      status: editorialStatusSchema.default('draft'),
      cover: z.union([httpUrl, z.literal('')]).default(''),
      noteIds: idList,
      kind: z.enum(['magazine', 'book']).default('magazine'),
      author: optionalText(120),
      summary: optionalText(2_000),
      translations: editionTranslationsSchema.optional(),
      coverArt: coverArtSchema.optional(),
    }), request.body);
    const actor = request.auth!.user.id;
    const edition = await app.prisma.$transaction(async tx => {
      const editionKind = input.kind.toUpperCase() as 'MAGAZINE' | 'BOOK';
      await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`edition-number:${editionKind}`})) IS NULL AS locked`);
      const aggregate = await tx.edition.aggregate({ where: { kind: editionKind }, _max: { number: true } });
      const number = (aggregate._max.number ?? -1) + 1;
      const coverResource = input.cover ? await tx.resource.create({ data: {
        type: 'IMAGE', storageDriver: 'EXTERNAL', name: `Portada de ${input.title}`, url: input.cover,
        alt: `Portada de ${input.title}`, credit: 'La Guillotina', license: 'Revisar licencia',
        status: toStatus(input.status), uploadStatus: 'COMPLETE', createdById: actor,
      } }) : null;
      const translationData = editionTranslations(input.translations, {
        title: input.title, subtitle: input.subtitle || null, date: input.date, author: input.author ?? null, summary: input.summary ?? null,
        publication: 'La Guillotina', headerLine: 'REVISTA ANARQUISTA / CONTRA TODA AUTORIDAD', masthead: input.cover ? { image: input.cover, alt: `Portada de ${input.title}` } : undefined,
      });
      const spanish = asRecord(translationData.es);
      const spanishInput = asRecord(asRecord(input.translations).es);
      const created = await tx.edition.create({ data: {
        title: spanishInput.status === 'published' ? spanish.title as string : input.title,
        slug: input.slug || `n-${String(number).padStart(3, '0')}-${slugify(input.title)}`,
        subtitle: spanishInput.status === 'published' ? spanish.subtitle as string | null : input.subtitle || null,
        dateLabel: spanishInput.status === 'published' ? spanish.dateLabel as string : input.date,
        status: toStatus(input.status), number,
        kind: editionKind, author: input.author, summary: input.summary,
        localizedContent: translationData as Prisma.InputJsonValue,
        coverArt: (input.coverArt ?? DEFAULT_COVER_ART) as Prisma.InputJsonValue,
        coverResourceId: coverResource?.id, createdById: actor, updatedById: actor, ...statusDates(input.status),
      } });
      const notes = await resolveNotes(tx, input.noteIds);
      if (notes.length) await tx.note.updateMany({ where: { id: { in: notes.map(note => note.id) } }, data: { editionId: created.id, updatedById: actor } });
      return created;
    });
    await audit(request, { action: `Creó la edición “${edition.title}”.`, entityType: 'edition', entityId: edition.id });
    return reply.code(201).send(editionResponse(edition));
  });

  app.patch('/admin/editions/:id', { preHandler: allowEditorial }, async request => {
    const { id } = parse(uuidParams, request.params);
    const input = parse(z.object({
      title: z.string().trim().min(2).max(180).optional(), slug: optionalText(180), subtitle: optionalText(240),
      date: optionalText(80), status: editorialStatusSchema.optional(), cover: z.union([httpUrl, z.literal('')]).optional(),
      noteIds: idListSchema.optional(), author: optionalText(120), summary: optionalText(2_000),
      translations: editionTranslationsSchema.optional(),
      coverArt: coverArtPatchSchema.optional(),
    }).refine(value => Object.keys(value).length > 0, 'El cambio no puede estar vacío.'), request.body);
    const existing = await app.prisma.edition.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'EDITION_NOT_FOUND', 'No encontramos esa edición.');
    const actor = request.auth!.user.id;
    const nextStatus = input.status ? toStatus(input.status) : undefined;
    const statusChanged = nextStatus !== undefined && nextStatus !== existing.status;
    const edition = await app.prisma.$transaction(async tx => {
      let coverResourceId: string | undefined;
      if (input.cover) {
        const resource = await tx.resource.create({ data: {
          type: 'IMAGE', storageDriver: 'EXTERNAL', name: `Portada de ${input.title ?? existing.title}`, url: input.cover,
          alt: `Portada de ${input.title ?? existing.title}`, credit: 'La Guillotina', license: 'Revisar licencia',
          status: nextStatus ?? existing.status, uploadStatus: 'COMPLETE', createdById: actor,
        } });
        coverResourceId = resource.id;
      }
      const hasLocalizedRootChanges = input.title !== undefined || input.subtitle !== undefined || input.date !== undefined || input.author !== undefined || input.summary !== undefined || Boolean(input.cover);
      const translationBase = Object.assign({
        title: existing.title, subtitle: existing.subtitle, date: existing.dateLabel, author: existing.author, summary: existing.summary,
      }, input);
      const translationData = input.translations || hasLocalizedRootChanges ? editionTranslations(input.translations, {
        title: translationBase.title, subtitle: translationBase.subtitle, date: translationBase.date,
        author: translationBase.author, summary: translationBase.summary, publication: existing.publication,
        headerLine: existing.headerLine, masthead: input.cover ? { image: input.cover, alt: `Portada de ${input.title ?? existing.title}` } : undefined,
      }, existing.localizedContent) : undefined;
      const spanishInput = asRecord(asRecord(input.translations).es);
      const spanish = asRecord(translationData?.es);
      const nextCoverArt = input.coverArt ? mergeCoverArt(existing.coverArt, input.coverArt) : undefined;
      const updated = await tx.edition.update({ where: { id }, data: {
        title: translationData && spanishInput.status === 'published' ? spanish.title as string : input.title, slug: input.slug,
        subtitle: translationData && spanishInput.status === 'published' ? spanish.subtitle as string | null : input.subtitle,
        dateLabel: translationData && spanishInput.status === 'published' ? spanish.dateLabel as string : input.date,
        status: nextStatus,
        author: translationData && spanishInput.status === 'published' ? spanish.author as string | null : input.author,
        summary: translationData && spanishInput.status === 'published' ? spanish.summary as string | null : input.summary,
        localizedContent: translationData as Prisma.InputJsonValue | undefined,
        coverArt: nextCoverArt as Prisma.InputJsonValue | undefined,
        coverResourceId, updatedById: actor, ...(statusChanged ? statusDates(input.status) : {}),
      } });
      if (input.noteIds) {
        const notes = await resolveNotes(tx, input.noteIds);
        await tx.note.updateMany({ where: { editionId: id, id: { notIn: notes.map(note => note.id) } }, data: { editionId: null, updatedById: actor } });
        if (notes.length) await tx.note.updateMany({ where: { id: { in: notes.map(note => note.id) } }, data: { editionId: id, updatedById: actor } });
      }
      return updated;
    });
    await audit(request, { action: `Actualizó la edición “${edition.title}”.`, entityType: 'edition', entityId: id });
    return editionResponse(edition);
  });

  app.delete('/admin/editions/:id', { preHandler: allowEditorial }, async request => {
    const { id } = parse(uuidParams, request.params);
    const existing = await app.prisma.edition.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'EDITION_NOT_FOUND', 'No encontramos esa edición.');
    const edition = await app.prisma.edition.update({ where: { id }, data: {
      status: 'DELETED', deletedAt: new Date(), updatedById: request.auth!.user.id,
    } });
    await audit(request, { action: `Eliminó lógicamente la edición “${edition.title}”.`, entityType: 'edition', entityId: id });
    return editionResponse(edition);
  });

  app.post('/admin/notes', { preHandler: allowEditorial }, async (request, reply) => {
    const input = parse(noteCreateSchema, request.body);
    assertCoverRectangle(input);
    const actor = request.auth!.user.id;
    const categories = await resolveCategories(app.prisma, input.categoryIds);
    const resources = await resolveResources(app.prisma, input.resourceIds);
    const note = await app.prisma.note.create({ data: {
      title: input.title, slug: input.slug || slugify(input.title), excerpt: input.excerpt, bodyMarkdown: input.body,
      status: toStatus(input.status), editionId: input.editionId || null, authorName: input.author || 'Redacción',
      readingMinutes: input.readingMinutes, fragment: input.fragment, x: input.x, y: input.y, width: input.w, height: input.h,
      tone: input.tone, readMoreLabel: input.readMoreLabel, readMoreSubtitle: input.readMoreSubtitle,
      coverTitleLines: input.coverTitleLines, coverExcerpt: input.coverExcerpt,
      coverButtonPosition: input.coverButtonPosition === null ? Prisma.JsonNull : input.coverButtonPosition,
      coverDepth: input.coverDepth,
      coverTypography: (input.coverTypography ?? DEFAULT_COVER_TYPOGRAPHY) as Prisma.InputJsonValue,
      sortOrder: input.sortOrder, editionLink: input.editionLink, createdById: actor, updatedById: actor,
      ...statusDates(input.status),
      localizedContent: noteTranslations(input.translations, input) as Prisma.InputJsonValue,
      categories: { create: categories.map(category => ({ categoryId: category.id })) },
      resources: { create: resources.map((resource, index) => ({ resourceId: resource.id, sortOrder: index })) },
    } });
    await audit(request, { action: `Creó la nota “${note.title}”.`, entityType: 'note', entityId: note.id });
    return reply.code(201).send(noteResponse(note));
  });

  app.patch('/admin/notes/:id', { preHandler: allowEditorial }, async request => {
    const { id } = parse(uuidParams, request.params);
    const input = parse(noteUpdateSchema, request.body);
    const existing = await app.prisma.note.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'NOTE_NOT_FOUND', 'No encontramos esa nota.');
    assertCoverRectangle(input, existing);
    const actor = request.auth!.user.id;
    const categories = input.categoryIds ? await resolveCategories(app.prisma, input.categoryIds) : null;
    const resources = input.resourceIds ? await resolveResources(app.prisma, input.resourceIds) : null;
    const hasLocalizedRootChanges = input.title !== undefined || input.excerpt !== undefined || input.body !== undefined || input.author !== undefined || input.readMoreLabel !== undefined || input.readMoreSubtitle !== undefined || input.coverTitleLines !== undefined || input.coverExcerpt !== undefined;
    const translationBase = Object.assign({
      title: existing.title, excerpt: existing.excerpt, body: existing.bodyMarkdown, author: existing.authorName,
      readMoreLabel: existing.readMoreLabel, readMoreSubtitle: existing.readMoreSubtitle,
      coverTitleLines: existing.coverTitleLines, coverExcerpt: existing.coverExcerpt,
    }, input);
    const translated = input.translations || hasLocalizedRootChanges ? noteTranslations(input.translations, {
      title: translationBase.title, excerpt: translationBase.excerpt, body: translationBase.body,
      author: translationBase.author, readMoreLabel: translationBase.readMoreLabel,
      readMoreSubtitle: translationBase.readMoreSubtitle, coverTitleLines: translationBase.coverTitleLines,
      coverExcerpt: translationBase.coverExcerpt,
    }, existing.localizedContent) : undefined;
    const spanishInput = asRecord(asRecord(input.translations).es);
    const spanish = asRecord(translated?.es);
    const nextCoverTypography = input.coverTypography ? mergeCoverTypography(existing.coverTypography, input.coverTypography) : undefined;
    const note = await app.prisma.note.update({ where: { id }, data: {
      title: translated && spanishInput.status === 'published' ? spanish.title as string : input.title,
      slug: input.slug,
      excerpt: translated && spanishInput.status === 'published' ? spanish.excerpt as string : input.excerpt,
      bodyMarkdown: translated && spanishInput.status === 'published' ? spanish.bodyMarkdown as string : input.body,
      status: input.status ? toStatus(input.status) : undefined, editionId: input.editionId === '' ? null : input.editionId,
      authorName: translated && spanishInput.status === 'published' ? spanish.authorName as string : input.author,
      readingMinutes: input.readingMinutes, fragment: input.fragment,
      x: input.x, y: input.y, width: input.w, height: input.h, tone: input.tone,
      readMoreLabel: translated && spanishInput.status === 'published' ? spanish.readMoreLabel as string : input.readMoreLabel,
      readMoreSubtitle: translated && spanishInput.status === 'published' ? spanish.readMoreSubtitle as string | null : input.readMoreSubtitle,
      coverTitleLines: translated && spanishInput.status === 'published' ? spanish.coverTitleLines as string[] : input.coverTitleLines,
      coverExcerpt: translated && spanishInput.status === 'published' ? spanish.coverExcerpt as string | null : input.coverExcerpt,
      coverButtonPosition: input.coverButtonPosition === null ? Prisma.JsonNull : input.coverButtonPosition,
      coverDepth: input.coverDepth,
      coverTypography: nextCoverTypography as Prisma.InputJsonValue | undefined,
      sortOrder: input.sortOrder, editionLink: input.editionLink, updatedById: actor,
      ...(input.status ? statusDates(input.status) : {}),
      ...(translated ? { localizedContent: translated as Prisma.InputJsonValue } : {}),
      ...(categories ? { categories: { deleteMany: {}, create: categories.map(category => ({ categoryId: category.id })) } } : {}),
      ...(resources ? { resources: { deleteMany: {}, create: resources.map((resource, index) => ({ resourceId: resource.id, sortOrder: index })) } } : {}),
    } });
    await audit(request, { action: `Actualizó la nota “${note.title}”.`, entityType: 'note', entityId: id });
    return noteResponse(note);
  });

  app.delete('/admin/notes/:id', { preHandler: allowEditorial }, async request => {
    const { id } = parse(uuidParams, request.params);
    const existing = await app.prisma.note.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'NOTE_NOT_FOUND', 'No encontramos esa nota.');
    const note = await app.prisma.note.update({ where: { id }, data: {
      status: 'DELETED', deletedAt: new Date(), updatedById: request.auth!.user.id,
    } });
    await audit(request, { action: `Eliminó lógicamente la nota “${note.title}”.`, entityType: 'note', entityId: id });
    return noteResponse(note);
  });

  app.post('/admin/resources', { preHandler: allowEditorial }, async (request, reply) => {
    const input = parse(resourceMetadataSchema.extend({ url: httpUrl }), request.body);
    const resource = await app.prisma.resource.create({ data: {
      type: input.type.toUpperCase() as never, storageDriver: 'EXTERNAL', name: input.name, url: input.url,
      alt: input.alt, credit: input.credit, license: input.license, status: toStatus(input.status),
      uploadStatus: 'COMPLETE', fileName: input.fileName, fileSize: input.fileSize, mimeType: input.mimeType,
      localizedContent: resourceTranslations(input.translations, input) as Prisma.InputJsonValue,
      resourceDate: input.date ? new Date(input.date) : new Date(), createdById: request.auth!.user.id,
    } });
    await audit(request, { action: `Agregó el recurso “${resource.name}”.`, entityType: 'resource', entityId: resource.id });
    return reply.code(201).send(serializeResource(resource, 'es', true));
  });

  app.patch('/admin/resources/:id', { preHandler: allowEditorial }, async request => {
    const { id } = parse(uuidParams, request.params);
    const input = parse(resourceUpdateSchema, request.body);
    const existing = await app.prisma.resource.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'No encontramos ese recurso.');
    const hasLocalizedRootChanges = input.name !== undefined || input.alt !== undefined || input.credit !== undefined || input.license !== undefined;
    const resource = await app.prisma.resource.update({ where: { id }, data: {
      type: input.type?.toUpperCase() as never, name: input.name, url: input.url, alt: input.alt,
      credit: input.credit, license: input.license, status: input.status ? toStatus(input.status) : undefined,
      ...(input.translations || hasLocalizedRootChanges ? { localizedContent: resourceTranslations(input.translations, {
        name: input.name ?? existing.name, alt: input.alt ?? existing.alt, credit: input.credit ?? existing.credit, license: input.license ?? existing.license,
      }, existing.localizedContent) as Prisma.InputJsonValue } : {}),
      deletedAt: input.status === 'deleted' ? new Date() : input.status ? null : undefined,
      resourceDate: input.date ? new Date(input.date) : undefined,
    } });
    await audit(request, { action: `Actualizó el recurso “${resource.name}”.`, entityType: 'resource', entityId: id });
    return serializeResource(resource, 'es', true);
  });

  app.post('/admin/categories', { preHandler: allowEditorial }, async (request, reply) => {
    const input = parse(categorySchema, request.body);
    const category = await app.prisma.category.create({ data: {
      slug: input.slug || slugify(input.name), name: input.name, description: input.description,
      color: input.color, status: 'PUBLISHED', createdById: request.auth!.user.id,
      localizedContent: categoryTranslations(input.translations, input) as Prisma.InputJsonValue,
    } });
    await audit(request, { action: `Creó la categoría “${category.name}”.`, entityType: 'category', entityId: category.id });
    return reply.code(201).send({ ...category, status: category.status.toLowerCase(), translations: category.localizedContent, translationStatus: translationStatuses(category.localizedContent) });
  });

  app.patch('/admin/categories/:id', { preHandler: allowEditorial }, async request => {
    const { id } = parse(uuidParams, request.params);
    const input = parse(categorySchema.partial().extend({ status: editorialStatusSchema.optional() }).strict()
      .refine(value => Object.keys(value).length > 0, 'El cambio no puede estar vacío.'), request.body);
    const existing = await app.prisma.category.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'CATEGORY_NOT_FOUND', 'No encontramos esa categoría.');
    const hasLocalizedRootChanges = input.name !== undefined || input.description !== undefined;
    const category = await app.prisma.category.update({ where: { id }, data: {
      slug: input.slug, name: input.name, description: input.description, color: input.color,
      status: input.status ? toStatus(input.status) : undefined, deletedAt: input.status === 'deleted' ? new Date() : input.status ? null : undefined,
      ...(input.translations || hasLocalizedRootChanges ? { localizedContent: categoryTranslations(input.translations, {
        name: input.name ?? existing.name, description: input.description ?? existing.description,
      }, existing.localizedContent) as Prisma.InputJsonValue } : {}),
    } });
    await audit(request, { action: `Actualizó la categoría “${category.name}”.`, entityType: 'category', entityId: id });
    return { ...category, status: category.status.toLowerCase(), translations: category.localizedContent, translationStatus: translationStatuses(category.localizedContent) };
  });

  app.patch('/admin/contacts/:id', { preHandler: allowModeration }, async request => {
    const { id } = parse(uuidParams, request.params);
    const input = parse(z.object({
      status: z.enum(['new', 'in_progress', 'answered', 'archived']).optional(),
      reply: z.string().trim().min(1).max(20_000).optional(),
      send: z.boolean().optional(),
    }).refine(value => Object.keys(value).length > 0, 'El cambio no puede estar vacío.')
      .refine(value => !value.send || Boolean(value.reply), { message: 'Para enviar una respuesta hace falta el texto.', path: ['reply'] })
      .refine(value => !(value.status === 'answered' && value.reply && value.send === false), { message: 'Una respuesta marcada como respondida debe enviarse.', path: ['send'] }), request.body);
    const existing = await app.prisma.contactMessage.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'CONTACT_NOT_FOUND', 'No encontramos ese mensaje de contacto.');
    const shouldSend = Boolean(input.reply && (input.send ?? input.status === 'answered'));
    let contact = await app.prisma.contactMessage.update({ where: { id }, data: {
      status: shouldSend ? 'IN_PROGRESS' : input.status?.toUpperCase() as never,
      archivedAt: input.status === 'archived' ? new Date() : input.status ? null : undefined,
      ...(input.reply ? { replies: { create: { body: input.reply, status: shouldSend ? 'QUEUED' : 'DRAFT', authorId: request.auth!.user.id } } } : {}),
    }, include: { replies: { orderBy: { createdAt: 'desc' }, take: 1 } } });
    const contactReply = contact.replies[0];
    if (shouldSend && contactReply) {
      try {
        await sendContactReply(app.config, {
          to: existing.email,
          contactName: existing.name,
          originalSubject: existing.subject,
          body: contactReply.body,
        });
        await app.prisma.$transaction([
          app.prisma.contactReply.update({ where: { id: contactReply.id }, data: { status: 'SENT', sentAt: new Date(), error: null } }),
          app.prisma.contactMessage.update({ where: { id }, data: { status: 'ANSWERED' } }),
        ]);
      } catch (error) {
        const safeMessage = safeDeliveryError(error);
        await app.prisma.$transaction([
          app.prisma.contactReply.update({ where: { id: contactReply.id }, data: { status: 'FAILED', error: safeMessage } }),
          app.prisma.contactMessage.update({ where: { id }, data: { status: 'IN_PROGRESS' } }),
        ]);
        if (error instanceof AppError) throw error;
        throw new AppError(502, 'MAIL_DELIVERY_FAILED', 'No pudimos enviar la respuesta. Quedó registrada para reintentar.');
      }
      contact = await app.prisma.contactMessage.findUniqueOrThrow({ where: { id }, include: { replies: { orderBy: { createdAt: 'desc' }, take: 1 } } });
    }
    await audit(request, { action: shouldSend ? 'Envió una respuesta de contacto.' : input.reply ? 'Guardó un borrador de respuesta.' : 'Actualizó un contacto.', entityType: 'contact', entityId: id });
    return {
      id: contact.id,
      status: contact.status.toLowerCase(),
      reply: contact.replies[0]?.body ?? '',
      replyStatus: contact.replies[0]?.status.toLowerCase() ?? null,
      sentAt: contact.replies[0]?.sentAt?.toISOString() ?? null,
    };
  });

  app.patch('/admin/comments/:id', { preHandler: allowModeration }, async request => {
    const { id } = parse(uuidParams, request.params);
    const input = parse(z.object({
      status: z.enum(['pending', 'visible', 'hidden', 'reported', 'deleted']),
      moderationReason: optionalText(1_000),
      moderationNote: optionalText(1_000),
    }).refine(value => !(value.moderationReason && value.moderationNote), {
      message: 'Usá moderationReason; moderationNote se conserva sólo por compatibilidad.',
    }), request.body);
    const existing = await app.prisma.comment.findUnique({ where: { id }, include: { user: { select: { email: true, displayName: true } } } });
    if (!existing) throw new AppError(404, 'COMMENT_NOT_FOUND', 'No encontramos ese comentario.');

    const now = new Date();
    const deleting = input.status === 'deleted';
    const enteringDeleted = deleting && existing.status !== 'DELETED';
    const isAnonymous = existing.userId === null;
    const moderationReason = input.moderationReason ?? input.moderationNote ?? (deleting ? DEFAULT_COMMENT_REMOVAL_REASON : existing.moderationNote);
    let comment = await app.prisma.comment.update({ where: { id }, data: {
      status: input.status.toUpperCase() as never,
      moderationNote: moderationReason,
      moderatedById: request.auth!.user.id,
      moderatedAt: now,
      deletedAt: deleting ? existing.deletedAt ?? now : null,
      ...(enteringDeleted ? {
        moderationEmailStatus: isAnonymous ? 'NOT_APPLICABLE' : 'PENDING',
        moderationEmailMessageId: null,
        moderationEmailError: null,
      } : {}),
    } });
    await audit(request, {
      action: deleting ? 'Eliminó lógicamente un comentario.' : `Marcó un comentario como ${input.status}.`,
      entityType: 'comment', entityId: id,
      metadata: { status: input.status, isAnonymous, reason: moderationReason ?? null },
    });

    if (enteringDeleted && existing.user) {
      try {
        const delivery = await sendCommentRemoval(app.config, {
          to: existing.user.email,
          displayName: existing.user.displayName,
          reason: moderationReason!,
        });
        comment = await app.prisma.comment.update({ where: { id }, data: {
          moderationEmailStatus: delivery.mode === 'development' ? 'DEVELOPMENT' : 'SENT',
          moderationEmailMessageId: delivery.messageId,
          moderationEmailError: null,
        } });
        await audit(request, {
          action: 'Registró el aviso automático de moderación.', entityType: 'comment', entityId: id,
          metadata: { delivery: delivery.mode, messageId: delivery.messageId },
        });
      } catch (error) {
        const safeError = safeModerationMailError(error);
        comment = await app.prisma.comment.update({ where: { id }, data: {
          moderationEmailStatus: 'FAILED', moderationEmailMessageId: null, moderationEmailError: safeError,
        } });
        await audit(request, {
          action: 'Falló el aviso automático de moderación.', level: 'WARNING', entityType: 'comment', entityId: id,
          metadata: { error: safeError },
        });
      }
    }

    return {
      id: comment.id,
      status: comment.status.toLowerCase(),
      isAnonymous,
      authorType: isAnonymous ? 'anonymous' : 'account',
      moderationReason: comment.moderationNote,
      moderatedAt: comment.moderatedAt!.toISOString(),
      deletedAt: comment.deletedAt?.toISOString() ?? null,
      emailDelivery: serializeCommentEmailDelivery(comment),
    };
  });

  app.patch('/admin/users/:id', { preHandler: allowAdmin }, async request => {
    const { id } = parse(uuidParams, request.params);
    const input = parse(z.object({ status: z.enum(['active', 'suspended']).optional(), role: z.enum(['reader', 'admin', 'editor', 'moderator']).optional() }).refine(value => Object.keys(value).length > 0), request.body);
    if (id === request.auth!.user.id && (input.status === 'suspended' || (input.role && input.role !== 'admin'))) {
      throw new AppError(409, 'CANNOT_LOCK_SELF', 'No podés suspender ni quitar tu propio acceso administrativo.');
    }
    const target = await app.prisma.user.findUnique({ where: { id } });
    if (!target) throw new AppError(404, 'USER_NOT_FOUND', 'No encontramos esa cuenta.');
    if (target.role === 'ADMIN' && (input.status === 'suspended' || (input.role && input.role !== 'admin'))) {
      const admins = await app.prisma.user.count({ where: { role: 'ADMIN', status: 'ACTIVE' } });
      if (admins <= 1) throw new AppError(409, 'LAST_ADMIN', 'Debe quedar al menos una cuenta administradora activa.');
    }
    const user = await app.prisma.user.update({ where: { id }, data: {
      status: input.status?.toUpperCase() as never, role: input.role?.toUpperCase() as never,
    } });
    if (input.status === 'suspended') await app.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await audit(request, { action: 'Actualizó el estado o rol de una cuenta.', entityType: 'user', entityId: id });
    return { id: user.id, name: user.displayName, email: user.email, role: user.role.toLowerCase(), status: user.status.toLowerCase() };
  });
};

const cssCoverPosition = z.string().trim().max(32).regex(
  /^(?:auto|-?(?:\d+|\d*\.\d+)(?:px|%|rem|em|vw|vh|cqw|cqh))$/,
  'Usá una longitud CSS segura, por ejemplo 12px, 8%, 1.5rem o auto.',
);
const coverButtonPositionSchema = z.object({
  left: cssCoverPosition.optional(),
  right: cssCoverPosition.optional(),
  bottom: cssCoverPosition.optional(),
}).strict();

const coverXSchema = z.number().int().min(0).max(COVER_CANVAS.width - 1);
const coverYSchema = z.number().int().min(COVER_CANVAS.mastheadHeight).max(COVER_CANVAS.height - 1);
const coverWidthSchema = z.number().int().min(1).max(COVER_CANVAS.width);
const coverHeightSchema = z.number().int().min(1).max(COVER_CANVAS.height - COVER_CANVAS.mastheadHeight);

const noteCreateSchema = z.object({
  title: z.string().trim().min(2).max(240), slug: optionalText(180).default(''), excerpt: z.string().trim().min(3).max(1_000),
  body: z.string().trim().min(3).max(500_000), status: editorialStatusSchema.default('draft'), editionId: z.union([z.string().uuid(), z.literal('')]).default(''),
  categoryIds: idList, resourceIds: z.array(z.string().uuid()).max(500).default([]), author: z.string().trim().max(120).default('Redacción'),
  readingMinutes: z.coerce.number().int().min(1).max(240).default(3), fragment: optionalText(80), x: coverXSchema.optional(),
  y: coverYSchema.optional(), w: coverWidthSchema.optional(), h: coverHeightSchema.optional(),
  tone: z.enum(['red', 'yellow', 'cyan', 'lime']).default('red'), readMoreLabel: z.string().trim().max(40).default('LEER +'),
  readMoreSubtitle: optionalText(240), sortOrder: z.number().int().min(0).default(0), editionLink: z.boolean().default(false),
  coverTitleLines: z.array(z.string().trim().min(1).max(120)).max(6).optional(),
  coverExcerpt: z.string().trim().max(2_000).nullable().optional(),
  coverButtonPosition: coverButtonPositionSchema.nullable().optional(),
  coverDepth: z.number().int().min(0).max(100).nullable().optional(),
  coverTypography: coverTypographySchema.optional(),
  translations: noteTranslationsSchema.optional(),
});

const noteUpdateSchema = z.object({
  title: z.string().trim().min(2).max(240).optional(),
  slug: optionalText(180),
  excerpt: z.string().trim().min(3).max(1_000).optional(),
  body: z.string().trim().min(3).max(500_000).optional(),
  status: editorialStatusSchema.optional(),
  editionId: z.union([z.string().uuid(), z.literal('')]).optional(),
  categoryIds: z.array(z.string().min(1).max(100)).max(500).optional(),
  resourceIds: z.array(z.string().uuid()).max(500).optional(),
  author: z.string().trim().max(120).optional(),
  readingMinutes: z.coerce.number().int().min(1).max(240).optional(),
  fragment: optionalText(80),
  x: coverXSchema.optional(),
  y: coverYSchema.optional(),
  w: coverWidthSchema.optional(),
  h: coverHeightSchema.optional(),
  tone: z.enum(['red', 'yellow', 'cyan', 'lime']).optional(),
  readMoreLabel: z.string().trim().max(40).optional(),
  readMoreSubtitle: optionalText(240),
  coverTitleLines: z.array(z.string().trim().min(1).max(120)).max(6).optional(),
  coverExcerpt: z.string().trim().max(2_000).nullable().optional(),
  coverButtonPosition: coverButtonPositionSchema.nullable().optional(),
  coverDepth: z.number().int().min(0).max(100).nullable().optional(),
  coverTypography: coverTypographyPatchSchema.optional(),
  sortOrder: z.number().int().min(0).optional(),
  editionLink: z.boolean().optional(),
  translations: noteTranslationsSchema.optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'El cambio no puede estar vacío.');

function assertCoverRectangle(input: { x?: number; y?: number; w?: number; h?: number }, current?: {
  x: number | null; y: number | null; width: number | null; height: number | null;
}) {
  const fieldErrors = coverRectangleErrors(resolveCoverRectangle(input, current));
  if (Object.keys(fieldErrors).length) {
    throw new AppError(400, 'VALIDATION_ERROR', 'La composición de portada queda fuera del lienzo.', { formErrors: [], fieldErrors });
  }
}

export const resourceMetadataSchema = z.object({
  type: z.enum(['image', 'video', 'pdf', 'audio', 'link']), name: z.string().trim().min(2).max(240),
  alt: z.string().trim().min(2).max(2_000), credit: z.string().trim().min(2).max(500), license: z.string().trim().min(2).max(500),
  status: editorialStatusSchema.default('draft'), fileName: optionalText(255), fileSize: z.coerce.number().int().min(0).default(0),
  mimeType: optionalText(160), date: z.string().datetime().optional(),
  translations: resourceTranslationsSchema.optional(),
});

const resourceUpdateSchema = z.object({
  type: z.enum(['image', 'video', 'pdf', 'audio', 'link']).optional(),
  name: z.string().trim().min(2).max(240).optional(),
  url: httpUrl.optional(),
  alt: z.string().trim().min(2).max(2_000).optional(),
  credit: z.string().trim().min(2).max(500).optional(),
  license: z.string().trim().min(2).max(500).optional(),
  status: editorialStatusSchema.optional(),
  date: z.string().datetime().optional(),
  translations: resourceTranslationsSchema.optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'El cambio no puede estar vacío.');

const categorySchema = z.object({
  name: z.string().trim().min(2).max(100), slug: optionalText(120), description: z.string().trim().min(3).max(2_000),
  color: z.enum(['red', 'yellow', 'cyan', 'lime']),
  translations: categoryTranslationsSchema.optional(),
});

const siteSettingsSchema = z.object({
  brandName: z.string().trim().min(2).max(120),
  publicationType: z.string().trim().min(2).max(160),
  statement: z.string().trim().min(2).max(240),
  headerLine: z.string().trim().min(2).max(240),
  navigation: z.array(z.object({
    label: z.string().trim().min(1).max(80),
    to: z.string().trim().min(1).max(500),
    sortOrder: z.number().int().min(0).max(1_000),
  })).max(30),
  footerStatement: z.string().trim().min(2).max(500),
  socialPrompt: z.string().trim().min(2).max(160),
  socialLinks: z.array(z.object({
    label: z.string().trim().min(1).max(80),
    url: httpUrl,
  })).max(30),
  contentByLocale: contentByLocaleSchema,
  seoByLocale: seoByLocaleSchema,
});

function toStatus(status: z.infer<typeof editorialStatusSchema>): EditorialStatus {
  return status.toUpperCase() as EditorialStatus;
}

export function statusDates(status?: z.infer<typeof editorialStatusSchema>) {
  return {
    publishedAt: status === 'published' ? new Date() : undefined,
    archivedAt: status === 'archived' ? new Date() : undefined,
    deletedAt: status === 'deleted' ? new Date() : status ? null : undefined,
  };
}

export function safeDeliveryError(error: unknown) {
  return error instanceof Error ? error.message.slice(0, 1_000) : 'Error de entrega no identificado.';
}

function normalizedTranslations(
  current: unknown,
  updates: unknown,
  spanish: Record<string, unknown>,
) {
  return mergeTranslationRecords(mergeTranslationRecords(current, { es: { status: 'published', ...spanish } }), updates);
}

function editionTranslations(
  updates: unknown,
  base: { title: string; subtitle: string | null; date: string; theme?: string | null; summary: string | null; author: string | null; publication: string; headerLine: string; masthead?: { image: string; alt: string } },
  current: unknown = {},
) {
  const normalizedUpdates = Object.fromEntries(Object.entries(asRecord(updates)).map(([locale, raw]) => {
    const value = asRecord(raw);
    return [locale, {
      ...value,
      ...(value.date !== undefined ? { dateLabel: value.date } : {}),
    }];
  }));
  return normalizedTranslations(current, normalizedUpdates, {
    title: base.title, subtitle: base.subtitle, dateLabel: base.date, theme: base.theme, summary: base.summary,
    author: base.author, publication: base.publication, headerLine: base.headerLine, ...(base.masthead ? { masthead: base.masthead } : {}),
  });
}

function noteTranslations(
  updates: unknown,
  base: { title: string; excerpt: string; body: string; author?: string; readMoreLabel?: string; readMoreSubtitle?: string | null; coverTitleLines?: string[]; coverExcerpt?: string | null },
  current: unknown = {},
) {
  const normalizedUpdates = Object.fromEntries(Object.entries(asRecord(updates)).map(([locale, raw]) => {
    const value = asRecord(raw);
    return [locale, { ...value, ...(value.body !== undefined ? { bodyMarkdown: value.body } : {}), ...(value.author !== undefined ? { authorName: value.author } : {}) }];
  }));
  return normalizedTranslations(current, normalizedUpdates, {
    title: base.title, subtitle: base.excerpt, summary: base.excerpt, excerpt: base.excerpt, bodyMarkdown: base.body,
    thumbnailText: base.excerpt, authorName: base.author as string, readMoreLabel: base.readMoreLabel as string,
    readMoreSubtitle: base.readMoreSubtitle ?? base.excerpt, coverTitleLines: base.coverTitleLines ?? [], coverExcerpt: base.coverExcerpt ?? null,
  });
}

function resourceTranslations(
  updates: unknown,
  base: { name: string; alt: string; credit: string; license: string },
  current: unknown = {},
) {
  return normalizedTranslations(current, updates, { name: base.name, title: base.name, alt: base.alt, caption: base.name, credit: base.credit, license: base.license });
}

function categoryTranslations(updates: unknown, base: { name: string; description: string }, current: unknown = {}) {
  return normalizedTranslations(current, updates, { name: base.name, description: base.description });
}

function editionResponse(edition: { id: string; slug: string; number: number | null; title: string; subtitle: string | null; dateLabel: string; status: string; localizedContent: Prisma.JsonValue; coverArt: Prisma.JsonValue; createdAt: Date; updatedAt: Date }) {
  return { id: edition.id, slug: edition.slug, number: edition.number == null ? '' : String(edition.number).padStart(2, '0'), title: edition.title, subtitle: edition.subtitle ?? '', date: edition.dateLabel, status: edition.status.toLowerCase(), coverArt: serializeCoverArt(edition.coverArt), translations: edition.localizedContent, translationStatus: translationStatuses(edition.localizedContent), createdAt: edition.createdAt.toISOString(), updatedAt: edition.updatedAt.toISOString() };
}

function noteResponse(note: { id: string; slug: string; title: string; excerpt: string; bodyMarkdown: string; status: string; editionId: string | null; authorName: string; readingMinutes: number; fragment: string | null; x: number | null; y: number | null; width: number | null; height: number | null; tone: string; sortOrder: number; editionLink: boolean; coverTitleLines: string[]; coverExcerpt: string | null; coverButtonPosition: Prisma.JsonValue | null; coverDepth: number | null; coverTypography: Prisma.JsonValue; localizedContent: Prisma.JsonValue; updatedAt: Date }) {
  return { id: note.id, slug: note.slug, title: note.title, excerpt: note.excerpt, body: note.bodyMarkdown, status: note.status.toLowerCase(), editionId: note.editionId, author: note.authorName, readingMinutes: note.readingMinutes, ...serializeCoverComposition(note), ...serializeCoverMetadata(note), coverTypography: serializeCoverTypography(note.coverTypography), translations: note.localizedContent, translationStatus: translationStatuses(note.localizedContent), updatedAt: note.updatedAt.toISOString() };
}

type QueryClient = PrismaClient | Prisma.TransactionClient;

async function resolveNotes(prisma: QueryClient, identifiers: string[]) {
  if (!identifiers.length) return [];
  const uuidIds = identifiers.filter(value => z.string().uuid().safeParse(value).success);
  return prisma.note.findMany({ where: { status: { not: 'DELETED' }, OR: [{ id: { in: uuidIds } }, { slug: { in: identifiers } }] } });
}

async function resolveCategories(prisma: QueryClient, identifiers: string[]) {
  if (!identifiers.length) return [];
  const uuidIds = identifiers.filter(value => z.string().uuid().safeParse(value).success);
  return prisma.category.findMany({ where: { status: { not: 'DELETED' }, OR: [{ id: { in: uuidIds } }, { slug: { in: identifiers } }] } });
}

async function resolveResources(prisma: QueryClient, identifiers: string[]) {
  if (!identifiers.length) return [];
  return prisma.resource.findMany({ where: { id: { in: identifiers }, status: { not: 'DELETED' } } });
}

function assertDashboardSection(role: UserRole, section: string) {
  if (section === 'all' || role === 'ADMIN') return;
  const allowed = role === 'EDITOR'
    ? ['editions', 'notes', 'resources', 'categories', 'analytics']
    : ['contacts', 'comments'];
  if (!allowed.includes(section)) throw new AppError(403, 'FORBIDDEN_DASHBOARD_SECTION', 'Tu rol no puede consultar esa sección del tablero.');
}
