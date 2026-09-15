import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { hashPassword, randomToken, sha256, verifyPassword } from '../../lib/crypto.js';
import { AppError, conflict } from '../../lib/errors.js';
import { parse } from '../../lib/validation.js';
import { sendPasswordReset } from '../../services/mailer.js';
import {
  issueSession,
  requireAuth,
  requireCsrf,
  revokeCurrentSession,
  rotateCsrf,
} from './auth-context.js';
import { serializeUser } from './user-serializer.js';
import { paginationMeta } from '../../lib/pagination.js';
import { localizedString, publicLocaleSchema, resolveEditorialTranslation } from '../content/localization.js';
import { serializeResource } from '../content/serializers.js';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8).max(128);
const registerSchema = z.object({ name: z.string().trim().min(2).max(80), email, password });
const loginSchema = z.object({ email, password: z.string().min(1).max(128) });
const profileSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  avatarUrl: z.string().max(2_100_000).refine(value => !value || value.startsWith('data:image/') || /^https?:\/\//i.test(value), 'Avatar inválido.').optional(),
  currentPassword: z.string().max(128).optional(),
  newPassword: password.optional(),
}).refine(value => !value.newPassword || Boolean(value.currentPassword), { message: 'Ingresá la contraseña actual.', path: ['currentPassword'] });
const preferencesSchema = z.object({
  theme: z.enum(['dark', 'light']).optional(),
  locale: z.enum(['es', 'en', 'ru']).optional(),
  readingSize: z.string().max(30).optional(),
  readingFont: z.string().max(30).optional(),
  contrast: z.string().max(30).optional(),
  analyticsOptOut: z.boolean().optional(),
  expiresAt: z.coerce.number().int().positive().optional(),
}).passthrough().nullable();

export const authRoutes: FastifyPluginAsync = async app => {
  app.post('/auth/register', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = parse(registerSchema, request.body);
    const existing = await app.prisma.user.findUnique({ where: { email: input.email } });
    if (existing) throw conflict('Ya existe una cuenta con ese correo.');
    const passwordHash = await hashPassword(input.password);
    const user = await app.prisma.user.create({
      data: {
        email: input.email,
        displayName: input.name,
        passwordHash,
        role: 'READER',
        profile: { create: { publicName: input.name } },
        preference: { create: {} },
      },
    });
    const csrfToken = await issueSession(request, reply, user.id);
    return reply.code(201).send({ user: await serializeUser(app.prisma, user.id), csrfToken });
  });

  app.post('/auth/login', { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = parse(loginSchema, request.body);
    const user = await app.prisma.user.findUnique({ where: { email: input.email } });
    if (!user?.passwordHash || !(await verifyPassword(user.passwordHash, input.password))) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.');
    }
    if (user.status === 'SUSPENDED') throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Esta cuenta está suspendida.');
    if (user.status === 'DELETED') throw new AppError(401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.');
    await app.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const csrfToken = await issueSession(request, reply, user.id);
    return { user: await serializeUser(app.prisma, user.id), csrfToken };
  });

  app.post('/auth/logout', async (request, reply) => {
    requireCsrf(request);
    await revokeCurrentSession(request, reply);
    return reply.code(204).send();
  });

  app.get('/auth/me', async request => {
    const auth = requireAuth(request);
    const csrfToken = await rotateCsrf(request);
    return { user: await serializeUser(app.prisma, auth.user.id), csrfToken };
  });

  app.patch('/auth/profile', async request => {
    requireCsrf(request);
    const auth = requireAuth(request);
    const input = parse(profileSchema, request.body);
    const user = await app.prisma.user.findUniqueOrThrow({ where: { id: auth.user.id } });
    let passwordHash: string | undefined;
    if (input.newPassword) {
      if (!user.passwordHash || !(await verifyPassword(user.passwordHash, currentPasswordOrEmpty(input.currentPassword)))) {
        throw new AppError(400, 'CURRENT_PASSWORD_INVALID', 'La contraseña actual no coincide.');
      }
      passwordHash = await hashPassword(input.newPassword);
    }
    await app.prisma.user.update({
      where: { id: user.id },
      data: {
        ...(input.name ? { displayName: input.name, profile: { upsert: { create: { publicName: input.name }, update: { publicName: input.name } } } } : {}),
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl || null } : {}),
        ...(passwordHash ? { passwordHash } : {}),
      },
    });
    if (passwordHash) await app.prisma.session.updateMany({ where: { userId: user.id, id: { not: auth.session.id } }, data: { revokedAt: new Date() } });
    return serializeUser(app.prisma, user.id);
  });

  app.patch('/auth/preferences', async request => {
    requireCsrf(request);
    const auth = requireAuth(request);
    const input = parse(preferencesSchema, request.body);
    if (!input) {
      await app.prisma.userPreference.deleteMany({ where: { userId: auth.user.id } });
      return serializeUser(app.prisma, auth.user.id);
    }
    const knownKeys = new Set(['theme', 'locale', 'readingSize', 'readingFont', 'contrast', 'analyticsOptOut', 'expiresAt']);
    const extra = Object.fromEntries(Object.entries(input).filter(([key]) => !knownKeys.has(key)));
    await app.prisma.userPreference.upsert({
      where: { userId: auth.user.id },
      create: {
        userId: auth.user.id,
        theme: input.theme,
        locale: input.locale,
        readingSize: input.readingSize,
        readingFont: input.readingFont,
        contrast: input.contrast,
        analyticsOptOut: input.analyticsOptOut,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
        extra: extra as Prisma.InputJsonValue,
      },
      update: {
        theme: input.theme,
        locale: input.locale,
        readingSize: input.readingSize,
        readingFont: input.readingFont,
        contrast: input.contrast,
        analyticsOptOut: input.analyticsOptOut,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : undefined,
        extra: extra as Prisma.InputJsonValue,
      },
    });
    return serializeUser(app.prisma, auth.user.id);
  });

  app.post('/auth/saved-notes/:noteId/toggle', async request => {
    requireCsrf(request);
    const auth = requireAuth(request);
    const { noteId } = parse(z.object({ noteId: z.string().min(1).max(100) }), request.params);
    const isUuid = z.string().uuid().safeParse(noteId).success;
    const note = await app.prisma.note.findFirst({ where: { OR: [{ slug: noteId }, ...(isUuid ? [{ id: noteId }] : [])], status: { not: 'DELETED' } } });
    if (!note) throw new AppError(404, 'NOTE_NOT_FOUND', 'No encontramos esa nota.');
    const key = { userId_noteId: { userId: auth.user.id, noteId: note.id } };
    const saved = await app.prisma.savedNote.findUnique({ where: key });
    if (saved) await app.prisma.savedNote.delete({ where: key });
    else await app.prisma.savedNote.create({ data: { userId: auth.user.id, noteId: note.id } });
    return serializeUser(app.prisma, auth.user.id);
  });

  app.get('/auth/saved-notes', async request => {
    const auth = requireAuth(request);
    const query = parse(z.object({
      locale: publicLocaleSchema,
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(50).default(12),
    }), request.query);
    const where = { userId: auth.user.id, note: { status: 'PUBLISHED' as const } };
    const [saved, total] = await app.prisma.$transaction([
      app.prisma.savedNote.findMany({
        where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize,
        include: {
          note: {
            include: {
              edition: { select: { slug: true } },
              resources: { where: { resource: { type: 'IMAGE', status: 'PUBLISHED', uploadStatus: 'COMPLETE' } }, orderBy: { sortOrder: 'asc' }, take: 1, include: { resource: true } },
            },
          },
        },
      }),
      app.prisma.savedNote.count({ where }),
    ]);
    return {
      items: saved.map(item => {
        const localized = resolveEditorialTranslation(item.note.localizedContent, query.locale).record;
        const image = item.note.resources[0]?.resource;
        const serializedImage = image ? serializeResource(image, query.locale) : null;
        return {
          id: item.note.slug, databaseId: item.note.id, slug: item.note.slug,
          title: localizedString(localized, 'title', item.note.title),
          thumbnailText: localizedString(localized, 'excerpt', item.note.excerpt),
          tone: item.note.tone, editionSlug: item.note.edition?.slug ?? null,
          image: serializedImage ? { url: serializedImage.url, alt: serializedImage.alt } : null,
          savedAt: item.createdAt.toISOString(),
        };
      }),
      pagination: paginationMeta(query.page, query.pageSize, total),
    };
  });

  app.delete('/auth/saved-notes', async request => {
    requireCsrf(request);
    const auth = requireAuth(request);
    await app.prisma.savedNote.deleteMany({ where: { userId: auth.user.id } });
    return serializeUser(app.prisma, auth.user.id);
  });

  app.post('/auth/password/forgot', { config: { rateLimit: { max: 3, timeWindow: '15 minutes' } } }, async request => {
    const { email: requestedEmail } = parse(z.object({ email }), request.body);
    const user = await app.prisma.user.findUnique({ where: { email: requestedEmail } });
    if (user?.status === 'ACTIVE' && user.passwordHash) {
      const token = randomToken();
      await app.prisma.$transaction([
        app.prisma.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } }),
        app.prisma.passwordResetToken.create({ data: {
          userId: user.id,
          tokenHash: sha256(token),
          expiresAt: new Date(Date.now() + app.config.passwordResetTtlMinutes * 60_000),
        } }),
      ]);
      await sendPasswordReset(app.config, {
        to: user.email,
        displayName: user.displayName,
        resetUrl: `${app.config.appPublicUrl}/recuperar-contrasena?token=${encodeURIComponent(token)}`,
      });
    }
    return { message: 'Si existe una cuenta activa, preparamos las instrucciones de recuperación.' };
  });

  app.post('/auth/password/reset', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async request => {
    const input = parse(z.object({ token: z.string().min(20).max(200), password }), request.body);
    const reset = await app.prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(input.token) }, include: { user: true } });
    if (!reset || reset.usedAt || reset.expiresAt <= new Date() || reset.user.status !== 'ACTIVE') {
      throw new AppError(400, 'INVALID_RESET_TOKEN', 'El enlace de recuperación no es válido o venció.');
    }
    const passwordHash = await hashPassword(input.password);
    await app.prisma.$transaction([
      app.prisma.user.update({ where: { id: reset.userId }, data: { passwordHash } }),
      app.prisma.passwordResetToken.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
      app.prisma.session.updateMany({ where: { userId: reset.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    return { message: 'La contraseña fue actualizada. Ya podés iniciar sesión.' };
  });

  app.delete('/auth/account', async (request, reply) => {
    requireCsrf(request);
    const auth = requireAuth(request);
    const anonymizedEmail = `deleted+${auth.user.id}@invalid.local`;
    await app.prisma.$transaction(async tx => {
      await tx.comment.updateMany({ where: { userId: auth.user.id }, data: { userId: null, authorName: 'Cuenta eliminada' } });
      await tx.commentVote.updateMany({ where: { userId: auth.user.id }, data: { userId: null } });
      await tx.noteRating.updateMany({ where: { userId: auth.user.id }, data: { userId: null } });
      await tx.savedNote.deleteMany({ where: { userId: auth.user.id } });
      await tx.userPreference.deleteMany({ where: { userId: auth.user.id } });
      await tx.oAuthAccount.deleteMany({ where: { userId: auth.user.id } });
      await tx.passwordResetToken.deleteMany({ where: { userId: auth.user.id } });
      await tx.session.deleteMany({ where: { userId: auth.user.id } });
      await tx.user.update({ where: { id: auth.user.id }, data: {
        email: anonymizedEmail,
        displayName: 'Cuenta eliminada',
        avatarUrl: null,
        passwordHash: null,
        status: 'DELETED',
        deletedAt: new Date(),
      } });
    });
    reply.clearCookie(app.config.sessionCookieName, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/auth/oauth/:provider', async request => {
    const { provider } = parse(z.object({ provider: z.enum(['google', 'x']) }), request.params);
    const config = app.config.oauth[provider];
    if (!config.clientId || !config.clientSecret || !config.callbackUrl) {
      throw new AppError(501, 'OAUTH_NOT_CONFIGURED', `OAuth ${provider.toUpperCase()} todavía no está configurado.`);
    }
    throw new AppError(501, 'OAUTH_PENDING', `OAuth ${provider.toUpperCase()} está preparado pero todavía no fue activado.`);
  });

  app.get('/auth/oauth/:provider/callback', async request => {
    const { provider } = parse(z.object({ provider: z.enum(['google', 'x']) }), request.params);
    throw new AppError(501, 'OAUTH_PENDING', `El callback OAuth ${provider.toUpperCase()} está reservado para la integración futura.`);
  });
};

export function currentPasswordOrEmpty(value?: string) {
  return value ?? '';
}
