import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Prisma, type EditorialStatus, type PrismaClient, type UserRole } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { paginationSchema } from '../../lib/pagination.js';
import { slugify } from '../../lib/slug.js';
import { parse } from '../../lib/validation.js';
import { sendContactReply } from '../../services/mailer.js';
import { requireCsrf, requireRole } from '../auth/auth-context.js';
import { serializeResource, serializeSiteSettings } from '../content/serializers.js';
import { audit } from './audit.js';
import { getDashboard } from './dashboard.service.js';

const editorialStatusSchema = z.enum(['draft', 'review', 'scheduled', 'published', 'archived', 'deleted']);
const uuidParams = z.object({ id: z.string().uuid() });
const optionalText = (max: number) => z.string().trim().max(max).optional();
const idList = z.array(z.string().min(1).max(100)).max(500).default([]);
const staffRoles: UserRole[] = ['ADMIN', 'EDITOR', 'MODERATOR'];
const editorialRoles: UserRole[] = ['ADMIN', 'EDITOR'];
const moderationRoles: UserRole[] = ['ADMIN', 'MODERATOR'];
const allowRoles = (roles: UserRole[]) => async (request: FastifyRequest) => { requireRole(request, roles); };
const allowEditorial = allowRoles(editorialRoles);
const allowModeration = allowRoles(moderationRoles);
const allowAdmin = allowRoles(['ADMIN']);

export const adminRoutes: FastifyPluginAsync = async app => {
  app.addHook('preHandler', async request => {
    requireRole(request, staffRoles);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) requireCsrf(request);
  });

  app.get('/admin/dashboard', async request => {
    const query = parse(paginationSchema.extend({
      section: z.enum(['all', 'editions', 'notes', 'resources', 'categories', 'contacts', 'comments', 'users', 'logs', 'analytics']).default('all'),
      status: editorialStatusSchema.optional(),
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
    return serializeSiteSettings(settings);
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
    } });
    await audit(request, { action: 'Actualizó la configuración editorial pública.', entityType: 'site_settings', entityId: settings.id });
    return serializeSiteSettings(settings);
  });

  app.post('/admin/editions', { preHandler: allowEditorial }, async (request, reply) => {
    const input = parse(z.object({
      title: z.string().trim().min(2).max(180),
      slug: optionalText(180),
      subtitle: optionalText(240).default(''),
      date: z.string().trim().min(2).max(80),
      status: editorialStatusSchema.default('draft'),
      cover: z.union([z.string().url(), z.literal('')]).default(''),
      noteIds: idList,
      kind: z.enum(['magazine', 'book']).default('magazine'),
      author: optionalText(120),
      summary: optionalText(2_000),
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
      const created = await tx.edition.create({ data: {
        title: input.title, slug: input.slug || `n-${String(number).padStart(3, '0')}-${slugify(input.title)}`,
        subtitle: input.subtitle || null, dateLabel: input.date, status: toStatus(input.status), number,
        kind: editionKind, author: input.author, summary: input.summary,
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
      date: optionalText(80), status: editorialStatusSchema.optional(), cover: z.union([z.string().url(), z.literal('')]).optional(),
      noteIds: idList.optional(), author: optionalText(120), summary: optionalText(2_000),
    }).refine(value => Object.keys(value).length > 0, 'El cambio no puede estar vacío.'), request.body);
    const existing = await app.prisma.edition.findUnique({ where: { id } });
    if (!existing) throw new AppError(404, 'EDITION_NOT_FOUND', 'No encontramos esa edición.');
    const actor = request.auth!.user.id;
    const edition = await app.prisma.$transaction(async tx => {
      let coverResourceId: string | undefined;
      if (input.cover) {
        const resource = await tx.resource.create({ data: {
          type: 'IMAGE', storageDriver: 'EXTERNAL', name: `Portada de ${input.title ?? existing.title}`, url: input.cover,
          alt: `Portada de ${input.title ?? existing.title}`, credit: 'La Guillotina', license: 'Revisar licencia',
          status: input.status ? toStatus(input.status) : existing.status, uploadStatus: 'COMPLETE', createdById: actor,
        } });
        coverResourceId = resource.id;
      }
      const updated = await tx.edition.update({ where: { id }, data: {
        title: input.title, slug: input.slug, subtitle: input.subtitle, dateLabel: input.date,
        status: input.status ? toStatus(input.status) : undefined, author: input.author, summary: input.summary,
        coverResourceId, updatedById: actor, ...(input.status ? statusDates(input.status) : {}),
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

  app.post('/admin/notes', { preHandler: allowEditorial }, async (request, reply) => {
    const input = parse(noteCreateSchema, request.body);
    const actor = request.auth!.user.id;
    const categories = await resolveCategories(app.prisma, input.categoryIds);
    const resources = await resolveResources(app.prisma, input.resourceIds);
    const note = await app.prisma.note.create({ data: {
      title: input.title, slug: input.slug || slugify(input.title), excerpt: input.excerpt, bodyMarkdown: input.body,
      status: toStatus(input.status), editionId: input.editionId || null, authorName: input.author || 'Redacción',
      readingMinutes: input.readingMinutes, fragment: input.fragment, x: input.x, y: input.y, width: input.w, height: input.h,
      tone: input.tone, readMoreLabel: input.readMoreLabel, readMoreSubtitle: input.readMoreSubtitle,
      sortOrder: input.sortOrder, editionLink: input.editionLink, createdById: actor, updatedById: actor,
      ...statusDates(input.status),
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
    const actor = request.auth!.user.id;
    const categories = input.categoryIds ? await resolveCategories(app.prisma, input.categoryIds) : null;
    const resources = input.resourceIds ? await resolveResources(app.prisma, input.resourceIds) : null;
    const note = await app.prisma.note.update({ where: { id }, data: {
      title: input.title, slug: input.slug, excerpt: input.excerpt, bodyMarkdown: input.body,
      status: input.status ? toStatus(input.status) : undefined, editionId: input.editionId === '' ? null : input.editionId,
      authorName: input.author, readingMinutes: input.readingMinutes, fragment: input.fragment,
      x: input.x, y: input.y, width: input.w, height: input.h, tone: input.tone,
      readMoreLabel: input.readMoreLabel, readMoreSubtitle: input.readMoreSubtitle,
      sortOrder: input.sortOrder, editionLink: input.editionLink, updatedById: actor,
      ...(input.status ? statusDates(input.status) : {}),
      ...(categories ? { categories: { deleteMany: {}, create: categories.map(category => ({ categoryId: category.id })) } } : {}),
      ...(resources ? { resources: { deleteMany: {}, create: resources.map((resource, index) => ({ resourceId: resource.id, sortOrder: index })) } } : {}),
    } });
    await audit(request, { action: `Actualizó la nota “${note.title}”.`, entityType: 'note', entityId: id });
    return noteResponse(note);
  });

  app.post('/admin/resources', { preHandler: allowEditorial }, async (request, reply) => {
    const input = parse(resourceMetadataSchema.extend({ url: z.string().url() }), request.body);
    const resource = await app.prisma.resource.create({ data: {
      type: input.type.toUpperCase() as never, storageDriver: 'EXTERNAL', name: input.name, url: input.url,
      alt: input.alt, credit: input.credit, license: input.license, status: toStatus(input.status),
      uploadStatus: 'COMPLETE', fileName: input.fileName, fileSize: input.fileSize, mimeType: input.mimeType,
      resourceDate: input.date ? new Date(input.date) : new Date(), createdById: request.auth!.user.id,
    } });
    await audit(request, { action: `Agregó el recurso “${resource.name}”.`, entityType: 'resource', entityId: resource.id });
    return reply.code(201).send(serializeResource(resource));
  });

  app.patch('/admin/resources/:id', { preHandler: allowEditorial }, async request => {
    const { id } = parse(uuidParams, request.params);
    const input = parse(resourceUpdateSchema, request.body);
    const resource = await app.prisma.resource.update({ where: { id }, data: {
      type: input.type?.toUpperCase() as never, name: input.name, url: input.url, alt: input.alt,
      credit: input.credit, license: input.license, status: input.status ? toStatus(input.status) : undefined,
      deletedAt: input.status === 'deleted' ? new Date() : input.status ? null : undefined,
      resourceDate: input.date ? new Date(input.date) : undefined,
    } });
    await audit(request, { action: `Actualizó el recurso “${resource.name}”.`, entityType: 'resource', entityId: id });
    return serializeResource(resource);
  });

  app.post('/admin/categories', { preHandler: allowEditorial }, async (request, reply) => {
    const input = parse(categorySchema, request.body);
    const category = await app.prisma.category.create({ data: {
      slug: input.slug || slugify(input.name), name: input.name, description: input.description,
      color: input.color, status: 'PUBLISHED', createdById: request.auth!.user.id,
    } });
    await audit(request, { action: `Creó la categoría “${category.name}”.`, entityType: 'category', entityId: category.id });
    return reply.code(201).send({ ...category, status: category.status.toLowerCase() });
  });

  app.patch('/admin/categories/:id', { preHandler: allowEditorial }, async request => {
    const { id } = parse(uuidParams, request.params);
    const input = parse(categorySchema.partial().extend({ status: editorialStatusSchema.optional() }).strict()
      .refine(value => Object.keys(value).length > 0, 'El cambio no puede estar vacío.'), request.body);
    const category = await app.prisma.category.update({ where: { id }, data: {
      slug: input.slug, name: input.name, description: input.description, color: input.color,
      status: input.status ? toStatus(input.status) : undefined, deletedAt: input.status === 'deleted' ? new Date() : input.status ? null : undefined,
    } });
    await audit(request, { action: `Actualizó la categoría “${category.name}”.`, entityType: 'category', entityId: id });
    return { ...category, status: category.status.toLowerCase() };
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
        const safeMessage = error instanceof Error ? error.message.slice(0, 1_000) : 'Error de entrega no identificado.';
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
    const input = parse(z.object({ status: z.enum(['pending', 'visible', 'hidden', 'reported']), moderationNote: optionalText(1_000) }), request.body);
    const comment = await app.prisma.comment.update({ where: { id }, data: {
      status: input.status.toUpperCase() as never, moderationNote: input.moderationNote,
      moderatedById: request.auth!.user.id, moderatedAt: new Date(),
    } });
    await audit(request, { action: `Marcó un comentario como ${input.status}.`, entityType: 'comment', entityId: id });
    return { id: comment.id, status: comment.status.toLowerCase() };
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

const noteCreateSchema = z.object({
  title: z.string().trim().min(2).max(240), slug: optionalText(180).default(''), excerpt: z.string().trim().min(3).max(1_000),
  body: z.string().trim().min(3).max(500_000), status: editorialStatusSchema.default('draft'), editionId: z.union([z.string().uuid(), z.literal('')]).default(''),
  categoryIds: idList, resourceIds: z.array(z.string().uuid()).max(500).default([]), author: z.string().trim().max(120).default('Redacción'),
  readingMinutes: z.coerce.number().int().min(1).max(240).default(3), fragment: optionalText(80), x: z.coerce.number().int().min(0).optional(),
  y: z.coerce.number().int().min(0).optional(), w: z.coerce.number().int().positive().optional(), h: z.coerce.number().int().positive().optional(),
  tone: z.enum(['red', 'yellow', 'cyan', 'lime']).default('red'), readMoreLabel: z.string().trim().max(40).default('LEER +'),
  readMoreSubtitle: optionalText(240), sortOrder: z.coerce.number().int().min(0).default(0), editionLink: z.boolean().default(false),
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
  x: z.coerce.number().int().min(0).optional(),
  y: z.coerce.number().int().min(0).optional(),
  w: z.coerce.number().int().positive().optional(),
  h: z.coerce.number().int().positive().optional(),
  tone: z.enum(['red', 'yellow', 'cyan', 'lime']).optional(),
  readMoreLabel: z.string().trim().max(40).optional(),
  readMoreSubtitle: optionalText(240),
  sortOrder: z.coerce.number().int().min(0).optional(),
  editionLink: z.boolean().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'El cambio no puede estar vacío.');

export const resourceMetadataSchema = z.object({
  type: z.enum(['image', 'video', 'pdf', 'audio', 'link']), name: z.string().trim().min(2).max(240),
  alt: z.string().trim().min(2).max(2_000), credit: z.string().trim().min(2).max(500), license: z.string().trim().min(2).max(500),
  status: editorialStatusSchema.default('draft'), fileName: optionalText(255), fileSize: z.coerce.number().int().min(0).default(0),
  mimeType: optionalText(160), date: z.string().datetime().optional(),
});

const resourceUpdateSchema = z.object({
  type: z.enum(['image', 'video', 'pdf', 'audio', 'link']).optional(),
  name: z.string().trim().min(2).max(240).optional(),
  url: z.string().url().optional(),
  alt: z.string().trim().min(2).max(2_000).optional(),
  credit: z.string().trim().min(2).max(500).optional(),
  license: z.string().trim().min(2).max(500).optional(),
  status: editorialStatusSchema.optional(),
  date: z.string().datetime().optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'El cambio no puede estar vacío.');

const categorySchema = z.object({
  name: z.string().trim().min(2).max(100), slug: optionalText(120), description: z.string().trim().min(3).max(2_000),
  color: z.enum(['red', 'yellow', 'cyan', 'lime']),
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
    url: z.string().url().max(2_000),
  })).max(30),
});

function toStatus(status: z.infer<typeof editorialStatusSchema>): EditorialStatus {
  return status.toUpperCase() as EditorialStatus;
}

function statusDates(status: z.infer<typeof editorialStatusSchema>) {
  return {
    publishedAt: status === 'published' ? new Date() : undefined,
    archivedAt: status === 'archived' ? new Date() : undefined,
    deletedAt: status === 'deleted' ? new Date() : status ? null : undefined,
  };
}

function editionResponse(edition: { id: string; slug: string; number: number | null; title: string; subtitle: string | null; dateLabel: string; status: string; createdAt: Date; updatedAt: Date }) {
  return { id: edition.id, slug: edition.slug, number: edition.number == null ? '' : String(edition.number).padStart(2, '0'), title: edition.title, subtitle: edition.subtitle ?? '', date: edition.dateLabel, status: edition.status.toLowerCase(), createdAt: edition.createdAt.toISOString(), updatedAt: edition.updatedAt.toISOString() };
}

function noteResponse(note: { id: string; slug: string; title: string; excerpt: string; bodyMarkdown: string; status: string; editionId: string | null; authorName: string; readingMinutes: number; updatedAt: Date }) {
  return { id: note.id, slug: note.slug, title: note.title, excerpt: note.excerpt, body: note.bodyMarkdown, status: note.status.toLowerCase(), editionId: note.editionId, author: note.authorName, readingMinutes: note.readingMinutes, updatedAt: note.updatedAt.toISOString() };
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
