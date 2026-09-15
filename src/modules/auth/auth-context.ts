import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { hmacSha256, randomToken, safeHashEqual, sha256 } from '../../lib/crypto.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

export async function hydrateAuth(request: FastifyRequest, reply: FastifyReply) {
  request.auth = null;
  const token = request.cookies[request.server.config.sessionCookieName];
  if (!token) return;
  const session = await request.server.prisma.session.findUnique({
    where: { tokenHash: sha256(token) },
    include: { user: true },
  });
  if (!session || session.revokedAt || session.expiresAt <= new Date() || session.user.status !== 'ACTIVE') {
    clearSessionCookie(reply);
    return;
  }
  request.auth = {
    session: { id: session.id, userId: session.userId, csrfHash: session.csrfHash, expiresAt: session.expiresAt },
    user: {
      id: session.user.id,
      email: session.user.email,
      displayName: session.user.displayName,
      avatarUrl: session.user.avatarUrl,
      role: session.user.role,
    },
  };
}

export function requireAuth(request: FastifyRequest) {
  if (!request.auth) throw new AppError(401, 'AUTH_REQUIRED', 'Necesitás iniciar sesión.');
  return request.auth;
}

export function requireRole(request: FastifyRequest, roles: UserRole[]) {
  const auth = requireAuth(request);
  if (!roles.includes(auth.user.role)) throw new AppError(403, 'FORBIDDEN', 'No tenés permisos para realizar esta acción.');
  return auth;
}

export function requireCsrf(request: FastifyRequest) {
  const auth = requireAuth(request);
  const token = request.headers['x-csrf-token'];
  if (typeof token !== 'string' || !safeHashEqual(token, auth.session.csrfHash)) {
    throw new AppError(403, 'INVALID_CSRF_TOKEN', 'La sesión de seguridad expiró. Volvé a intentarlo.');
  }
}

export async function issueSession(request: FastifyRequest, reply: FastifyReply, userId: string) {
  const token = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + request.server.config.sessionTtlDays * DAY_MS);
  await request.server.prisma.$transaction(async tx => {
    await tx.session.deleteMany({ where: { OR: [{ expiresAt: { lte: new Date() } }, { revokedAt: { not: null } }] } });
    const active = await tx.session.findMany({ where: { userId, revokedAt: null }, orderBy: { createdAt: 'desc' }, skip: 4 });
    if (active.length) await tx.session.updateMany({ where: { id: { in: active.map(item => item.id) } }, data: { revokedAt: new Date() } });
    await tx.session.create({ data: { userId, tokenHash: sha256(token), csrfHash: sha256(csrfToken), expiresAt } });
  });
  reply.setCookie(request.server.config.sessionCookieName, token, sessionCookieOptions(request));
  return csrfToken;
}

export async function rotateCsrf(request: FastifyRequest) {
  const auth = requireAuth(request);
  const csrfToken = randomToken();
  await request.server.prisma.session.update({ where: { id: auth.session.id }, data: { csrfHash: sha256(csrfToken), lastSeenAt: new Date() } });
  auth.session.csrfHash = sha256(csrfToken);
  return csrfToken;
}

export async function revokeCurrentSession(request: FastifyRequest, reply: FastifyReply) {
  const auth = requireAuth(request);
  await request.server.prisma.session.update({ where: { id: auth.session.id }, data: { revokedAt: new Date() } });
  clearSessionCookie(reply);
}

function sessionCookieOptions(request: FastifyRequest) {
  const config = request.server.config;
  return {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    domain: config.cookieDomain,
    maxAge: config.sessionTtlDays * 24 * 60 * 60,
  } as const;
}

export function clearSessionCookie(reply: FastifyReply) {
  const config = reply.server.config;
  reply.clearCookie(config.sessionCookieName, {
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: config.cookieSameSite,
    domain: config.cookieDomain,
  });
}

export function voterIdentity(request: FastifyRequest, reply: FastifyReply) {
  if (request.auth) return { voterKey: `user:${request.auth.user.id}`, userId: request.auth.user.id };
  const cookieName = 'lg_voter';
  const signed = request.cookies[cookieName];
  const unsigned = signed ? request.unsignCookie(signed) : null;
  const token = unsigned?.valid ? unsigned.value : randomToken();
  if (!unsigned?.valid) {
    reply.setCookie(cookieName, token, {
      path: '/', httpOnly: true, signed: true, secure: request.server.config.cookieSecure,
      sameSite: request.server.config.cookieSameSite, maxAge: 365 * 24 * 60 * 60,
    });
  }
  return { voterKey: `anon:${hmacSha256(request.server.config.anonymousHmacSecret, token)}`, userId: null };
}
