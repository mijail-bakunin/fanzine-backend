import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../src/lib/crypto.js';
import {
  authHeaders, closeTestDatabase, cookieValue, createTestContext, credentials, ids, login,
  mailboxMessages, namedCookie, prefix, prisma, type TestContext,
} from './helpers/test-context.js';

let context: TestContext;

beforeEach(async () => { context = await createTestContext(); });
afterEach(async () => { await context.app.close(); });
afterAll(closeTestDatabase);

describe('sistema, errores y perímetro HTTP', () => {
  it('responde health y readiness con datos reales de PostgreSQL', async () => {
    const health = await context.app.inject({ method: 'GET', url: `${prefix}/health` });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: 'ok', service: 'backend-guillotina' });
    expect(Number.isNaN(Date.parse(health.json().timestamp))).toBe(false);

    const ready = await context.app.inject({ method: 'GET', url: `${prefix}/health/ready` });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready', database: 'connected' });
    expect(await prisma.user.count()).toBeGreaterThan(0);
  });

  it('uniforma rutas inexistentes y agrega headers defensivos', async () => {
    const missing = await context.app.inject({ method: 'GET', url: `${prefix}/ruta-inexistente` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: 'ROUTE_NOT_FOUND', message: expect.any(String), requestId: expect.any(String) } });
    const health = await context.app.inject({ method: 'GET', url: `${prefix}/health` });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('acepta preflight del frontend y rechaza orígenes fuera de CORS', async () => {
    const allowed = await context.app.inject({ method: 'OPTIONS', url: `${prefix}/admin/editions/${ids.edition}`, headers: {
      origin: 'http://localhost:5173', 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'content-type,x-csrf-token',
    } });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(allowed.headers['access-control-allow-methods']).toContain('PATCH');

    const denied = await context.app.inject({ method: 'OPTIONS', url: `${prefix}/admin/editions/${ids.edition}`, headers: {
      origin: 'https://malicioso.example', 'access-control-request-method': 'PATCH',
    } });
    expect(denied.statusCode).toBeGreaterThanOrEqual(400);
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('registro, login y sesiones opacas', () => {
  it('registra sólo reader, hashea la clave y emite cookie HttpOnly más CSRF', async () => {
    const response = await context.app.inject({ method: 'POST', url: `${prefix}/auth/register`, payload: {
      name: 'Nueva lectora', email: 'NUEVA@Example.org', password: 'clave-segura-123', role: 'admin',
    } });
    expect(response.statusCode).toBe(201);
    expect(response.json().user).toMatchObject({ name: 'Nueva lectora', email: 'nueva@example.org', role: 'reader', status: 'active' });
    expect(response.json().csrfToken).toEqual(expect.any(String));
    const setCookie = String(response.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    const stored = await prisma.user.findUniqueOrThrow({ where: { email: 'nueva@example.org' } });
    expect(stored.passwordHash).not.toBe('clave-segura-123');
    expect(stored.passwordHash).toMatch(/^\$argon2id\$/);
    expect(stored.role).toBe('READER');
  });

  it('rechaza registros inválidos y correos duplicados sin crear filas parciales', async () => {
    const weak = await context.app.inject({ method: 'POST', url: `${prefix}/auth/register`, payload: { name: 'X', email: 'incorrecto', password: '123' } });
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    const duplicate = await context.app.inject({ method: 'POST', url: `${prefix}/auth/register`, payload: { name: 'Duplicada', email: credentials.reader.email, password: 'clave-segura' } });
    expect(duplicate.statusCode).toBe(409);
    expect(await prisma.user.count({ where: { email: credentials.reader.email } })).toBe(1);
  });

  it('distingue credenciales válidas, suspendidas y eliminadas sin filtrar datos', async () => {
    const valid = await context.app.inject({ method: 'POST', url: `${prefix}/auth/login`, payload: credentials.reader });
    expect(valid.statusCode).toBe(200);
    expect(valid.json().user.role).toBe('reader');
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.reader } })).lastLoginAt).toBeInstanceOf(Date);

    const wrong = await context.app.inject({ method: 'POST', url: `${prefix}/auth/login`, payload: { email: credentials.reader.email, password: 'equivocada' } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
    const suspended = await context.app.inject({ method: 'POST', url: `${prefix}/auth/login`, payload: credentials.suspended });
    expect(suspended.statusCode).toBe(403);
    const deleted = await context.app.inject({ method: 'POST', url: `${prefix}/auth/login`, payload: credentials.deleted });
    expect(deleted.statusCode).toBe(401);
    expect(deleted.json().error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: wrong.json().error.message });
  });

  it('persiste sólo el hash del token y limita a cinco sesiones activas', async () => {
    const cookies: string[] = [];
    for (let index = 0; index < 6; index++) {
      const response = await context.app.inject({ method: 'POST', url: `${prefix}/auth/login`, payload: credentials.reader });
      expect(response.statusCode).toBe(200);
      cookies.push(namedCookie(response, 'lg_session'));
    }
    const token = cookieValue(cookies.at(-1)!);
    const session = await prisma.session.findUniqueOrThrow({ where: { tokenHash: sha256(token) } });
    expect(session.tokenHash).not.toBe(token);
    expect(await prisma.session.count({ where: { userId: ids.reader, revokedAt: null } })).toBe(5);
    expect(await prisma.session.count({ where: { userId: ids.reader, revokedAt: { not: null } } })).toBe(1);
    const oldest = await context.app.inject({ method: 'GET', url: `${prefix}/auth/me`, headers: { cookie: cookies[0] } });
    expect(oldest.statusCode).toBe(401);
  });

  it('aplica rate limiting al login basándose en solicitudes observadas', async () => {
    const responses = [];
    for (let index = 0; index < 9; index++) {
      responses.push(await context.app.inject({ method: 'POST', url: `${prefix}/auth/login`, payload: { email: 'nadie@example.org', password: 'incorrecta' } }));
    }
    expect(responses.slice(0, 8).every(response => response.statusCode === 401)).toBe(true);
    expect(responses[8]!.statusCode).toBe(429);
    expect(Number(responses[8]!.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('CSRF, perfil, preferencias y cierre de sesión', () => {
  it('exige CSRF válido y rota el token al consultar la sesión', async () => {
    const auth = await login(context.app, 'reader');
    const missing = await context.app.inject({ method: 'PATCH', url: `${prefix}/auth/profile`, headers: { cookie: auth.cookie }, payload: { name: 'Sin CSRF' } });
    expect(missing.statusCode).toBe(403);
    const wrong = await context.app.inject({ method: 'PATCH', url: `${prefix}/auth/profile`, headers: { cookie: auth.cookie, 'x-csrf-token': 'token-incorrecto' }, payload: { name: 'CSRF incorrecto' } });
    expect(wrong.statusCode).toBe(403);

    const me = await context.app.inject({ method: 'GET', url: `${prefix}/auth/me`, headers: { cookie: auth.cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().csrfToken).not.toBe(auth.csrfToken);
    const stale = await context.app.inject({ method: 'PATCH', url: `${prefix}/auth/profile`, headers: authHeaders(auth), payload: { name: 'Token viejo' } });
    expect(stale.statusCode).toBe(403);
    const fresh = await context.app.inject({ method: 'PATCH', url: `${prefix}/auth/profile`, headers: { cookie: auth.cookie, 'x-csrf-token': me.json().csrfToken }, payload: { name: 'Nombre actualizado' } });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().name).toBe('Nombre actualizado');
  });

  it('actualiza contraseña sólo con la clave actual y revoca otras sesiones', async () => {
    const first = await login(context.app, 'reader');
    const second = await login(context.app, 'reader');
    const invalid = await context.app.inject({ method: 'PATCH', url: `${prefix}/auth/profile`, headers: authHeaders(second), payload: { currentPassword: 'incorrecta', newPassword: 'clave-nueva-segura' } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe('CURRENT_PASSWORD_INVALID');

    const changed = await context.app.inject({ method: 'PATCH', url: `${prefix}/auth/profile`, headers: authHeaders(second), payload: { currentPassword: credentials.reader.password, newPassword: 'clave-nueva-segura' } });
    expect(changed.statusCode).toBe(200);
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/auth/me`, headers: { cookie: first.cookie } })).statusCode).toBe(401);
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/auth/me`, headers: { cookie: second.cookie } })).statusCode).toBe(200);
    expect((await context.app.inject({ method: 'POST', url: `${prefix}/auth/login`, payload: credentials.reader })).statusCode).toBe(401);
    expect((await context.app.inject({ method: 'POST', url: `${prefix}/auth/login`, payload: { email: credentials.reader.email, password: 'clave-nueva-segura' } })).statusCode).toBe(200);
  });

  it('guarda, devuelve y elimina preferencias conocidas y adicionales', async () => {
    const auth = await login(context.app, 'reader');
    const updated = await context.app.inject({ method: 'PATCH', url: `${prefix}/auth/preferences`, headers: authHeaders(auth), payload: { theme: 'light', locale: 'en', analyticsOptOut: true, customReaderFlag: 'compact' } });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().preferences).toMatchObject({ theme: 'light', locale: 'en', analyticsOptOut: true, customReaderFlag: 'compact' });
    const stored = await prisma.userPreference.findUniqueOrThrow({ where: { userId: ids.reader } });
    expect(stored.extra).toMatchObject({ customReaderFlag: 'compact' });
    const removed = await context.app.inject({ method: 'PATCH', url: `${prefix}/auth/preferences`, headers: { ...authHeaders(auth), 'content-type': 'application/json' }, payload: 'null' });
    expect(removed.statusCode).toBe(200);
    expect(removed.json().preferences).toBeNull();
    expect(await prisma.userPreference.findUnique({ where: { userId: ids.reader } })).toBeNull();
  });

  it('revoca la sesión al cerrar y elimina la cookie', async () => {
    const auth = await login(context.app, 'reader');
    const logout = await context.app.inject({ method: 'POST', url: `${prefix}/auth/logout`, headers: authHeaders(auth) });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/auth/me`, headers: { cookie: auth.cookie } })).statusCode).toBe(401);
    expect(await prisma.session.count({ where: { userId: ids.reader, revokedAt: { not: null } } })).toBe(1);
  });
});

describe('notas guardadas y ciclo de vida de cuenta', () => {
  it('lista guardadas publicadas con datos completos, localización, imagen y paginación', async () => {
    await prisma.savedNote.create({ data: { userId: ids.reader, noteId: ids.note } });
    const auth = await login(context.app, 'reader');
    const response = await context.app.inject({ method: 'GET', url: `${prefix}/auth/saved-notes?locale=en&page=1&pageSize=1`, headers: { cookie: auth.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ id: 'freedom', databaseId: ids.note, slug: 'freedom', title: 'Freedom is not requested', thumbnailText: 'Direct action sentinel', tone: 'red', editionSlug: 'n-012-la-libertad', image: { url: 'https://example.org/image.webp' }, savedAt: expect.any(String) }],
      pagination: { page: 1, pageSize: 1, total: 1, totalPages: 1 },
    });
    const anonymous = await context.app.inject({ method: 'GET', url: `${prefix}/auth/saved-notes` });
    expect(anonymous.statusCode).toBe(401);
  });

  it('lista una guardada sin edición ni imagen usando valores editoriales base', async () => {
    await prisma.note.update({ where: { id: ids.secondNote }, data: { editionId: null } });
    await prisma.savedNote.create({ data: { userId: ids.reader, noteId: ids.secondNote } });
    const auth = await login(context.app, 'reader');
    const response = await context.app.inject({ method: 'GET', url: `${prefix}/auth/saved-notes?locale=ru`, headers: { cookie: auth.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([expect.objectContaining({
      id: 'memory', title: 'Memoria viva', editionSlug: null, image: null,
    })]);
  });
  it('alterna guardadas por slug o UUID, evita duplicados y permite vaciarlas', async () => {
    const auth = await login(context.app, 'reader');
    const first = await context.app.inject({ method: 'POST', url: `${prefix}/auth/saved-notes/freedom/toggle`, headers: authHeaders(auth) });
    expect(first.statusCode).toBe(200);
    expect(first.json().savedNoteIds).toEqual(['freedom']);
    expect(await prisma.savedNote.count({ where: { userId: ids.reader, noteId: ids.note } })).toBe(1);
    const removed = await context.app.inject({ method: 'POST', url: `${prefix}/auth/saved-notes/${ids.note}/toggle`, headers: authHeaders(auth) });
    expect(removed.json().savedNoteIds).toEqual([]);
    await context.app.inject({ method: 'POST', url: `${prefix}/auth/saved-notes/memory/toggle`, headers: authHeaders(auth) });
    const clear = await context.app.inject({ method: 'DELETE', url: `${prefix}/auth/saved-notes`, headers: authHeaders(auth) });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().savedNoteIds).toEqual([]);
    expect(await prisma.savedNote.count({ where: { userId: ids.reader } })).toBe(0);
  });

  it('rechaza guardar notas inexistentes o eliminadas', async () => {
    const auth = await login(context.app, 'reader');
    const missing = await context.app.inject({ method: 'POST', url: `${prefix}/auth/saved-notes/no-existe/toggle`, headers: authHeaders(auth) });
    expect(missing.statusCode).toBe(404);
    await prisma.note.update({ where: { id: ids.note }, data: { status: 'DELETED', deletedAt: new Date() } });
    const deleted = await context.app.inject({ method: 'POST', url: `${prefix}/auth/saved-notes/freedom/toggle`, headers: authHeaders(auth) });
    expect(deleted.statusCode).toBe(404);
  });

  it('anonimiza una cuenta y conserva contenido comunitario sin datos personales', async () => {
    const auth = await login(context.app, 'reader');
    await prisma.comment.create({ data: { noteId: ids.note, userId: ids.reader, authorName: 'Lectora', body: 'Comentario de la cuenta.', status: 'VISIBLE' } });
    await prisma.savedNote.create({ data: { userId: ids.reader, noteId: ids.note } });
    const response = await context.app.inject({ method: 'DELETE', url: `${prefix}/auth/account`, headers: authHeaders(auth) });
    expect(response.statusCode).toBe(204);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ids.reader } });
    expect(user).toMatchObject({ displayName: 'Cuenta eliminada', passwordHash: null, status: 'DELETED' });
    expect(user.email).toBe(`deleted+${ids.reader}@invalid.local`);
    expect(await prisma.session.count({ where: { userId: ids.reader } })).toBe(0);
    expect(await prisma.savedNote.count({ where: { userId: ids.reader } })).toBe(0);
    expect(await prisma.userPreference.count({ where: { userId: ids.reader } })).toBe(0);
    const comment = await prisma.comment.findFirstOrThrow({ where: { body: 'Comentario de la cuenta.' } });
    expect(comment).toMatchObject({ userId: null, authorName: 'Cuenta eliminada' });
  });
});

describe('recuperación y OAuth reservado', () => {
  it('no revela cuentas inexistentes ni genera correos para ellas', async () => {
    const response = await context.app.inject({ method: 'POST', url: `${prefix}/auth/password/forgot`, payload: { email: 'nadie@example.org' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().message).toContain('Si existe');
    expect(await mailboxMessages()).toEqual([]);
    expect(await prisma.passwordResetToken.count()).toBe(0);
  });

  it('genera un token de un uso, rechaza vencidos y revoca sesiones tras restablecer', async () => {
    const auth = await login(context.app, 'reader');
    const forgot = await context.app.inject({ method: 'POST', url: `${prefix}/auth/password/forgot`, payload: { email: credentials.reader.email } });
    expect(forgot.statusCode).toBe(200);
    const messages = await mailboxMessages();
    expect(messages).toHaveLength(1);
    const token = new URL(messages[0]!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
    const stored = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: ids.reader } });
    expect(stored.tokenHash).toBe(sha256(token));
    expect(stored.tokenHash).not.toBe(token);
    await prisma.passwordResetToken.update({ where: { id: stored.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const expired = await context.app.inject({ method: 'POST', url: `${prefix}/auth/password/reset`, payload: { token, password: 'clave-restablecida' } });
    expect(expired.statusCode).toBe(400);

    await context.app.inject({ method: 'POST', url: `${prefix}/auth/password/forgot`, payload: { email: credentials.reader.email } });
    const freshMessages = await mailboxMessages();
    const freshToken = new URL(freshMessages.at(-1)!.text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
    const reset = await context.app.inject({ method: 'POST', url: `${prefix}/auth/password/reset`, payload: { token: freshToken, password: 'clave-restablecida' } });
    expect(reset.statusCode).toBe(200);
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/auth/me`, headers: { cookie: auth.cookie } })).statusCode).toBe(401);
    expect((await context.app.inject({ method: 'POST', url: `${prefix}/auth/password/reset`, payload: { token: freshToken, password: 'otra-clave' } })).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'POST', url: `${prefix}/auth/login`, payload: { email: credentials.reader.email, password: 'clave-restablecida' } })).statusCode).toBe(200);
  });

  it('valida proveedores y declara explícitamente la integración OAuth pendiente', async () => {
    const invalid = await context.app.inject({ method: 'GET', url: `${prefix}/auth/oauth/facebook` });
    expect(invalid.statusCode).toBe(400);
    const google = await context.app.inject({ method: 'GET', url: `${prefix}/auth/oauth/google` });
    expect(google.statusCode).toBe(501);
    expect(google.json().error.code).toBe('OAUTH_NOT_CONFIGURED');
    const callback = await context.app.inject({ method: 'GET', url: `${prefix}/auth/oauth/x/callback?code=demo&state=demo` });
    expect(callback.statusCode).toBe(501);
    expect(callback.json().error.code).toBe('OAUTH_PENDING');
  });
});
