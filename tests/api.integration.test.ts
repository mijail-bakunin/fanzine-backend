import { readdir, readFile, rm } from 'node:fs/promises';
import { S3Client } from '@aws-sdk/client-s3';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/build-app.js';
import { loadConfig } from '../src/config/env.js';
import { hashPassword } from '../src/lib/crypto.js';

const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://guillotina:guillotina_dev@localhost:5432/laguillotina_test?schema=public';
const storagePath = './storage/test-integration';
const mailboxPath = `${storagePath}/mailbox`;
const config = loadConfig({
  ...process.env,
  NODE_ENV: 'test',
  DATABASE_URL: databaseUrl,
  API_PREFIX: '/laguillotina/api/v1',
  COOKIE_SECRET: 'test-cookie-secret-with-more-than-thirty-two-characters',
  ANONYMOUS_HMAC_SECRET: 'test-anonymous-secret-with-more-than-thirty-two-characters',
  ANALYTICS_HMAC_SECRET: 'test-analytics-secret-with-more-than-thirty-two-characters',
  CRON_SECRET: 'test-cron-secret-long-enough',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_PATH: storagePath,
  DEV_MAILBOX_PATH: mailboxPath,
  PUBLIC_STORAGE_BASE_URL: 'http://localhost:3001/laguillotina/api/v1/media',
  FRONTEND_ORIGINS: 'http://localhost:5173,http://127.0.0.1:5173',
  LOG_LEVEL: 'silent',
});
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
const prefix = config.apiPrefix;
let app: Awaited<ReturnType<typeof buildApp>>;
let adminCookie = '';
let adminCsrf = '';
let readerCookie = '';
let readerCsrf = '';
let editorCookie = '';
let editorCsrf = '';
let moderatorCookie = '';
let moderatorCsrf = '';
let editionId = '';
let noteId = '';
let editorId = '';
let moderatorId = '';

beforeAll(async () => {
  await rm(storagePath, { recursive: true, force: true });
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      analytics_daily, analytics_events, error_logs, admin_logs, contact_replies, contact_messages,
      saved_notes, note_ratings, comment_reports, comment_votes, comments, resource_uploads,
      edition_resources, note_resources, resources, note_categories, categories, notes, editions,
      password_reset_tokens, oauth_accounts, sessions, user_preferences, user_profiles, users, site_settings
    RESTART IDENTITY CASCADE
  `);
  const [adminHash, readerHash, editorHash, moderatorHash] = await Promise.all([
    hashPassword('guillotina-admin'),
    hashPassword('guillotina'),
    hashPassword('guillotina-editor'),
    hashPassword('guillotina-moderator'),
  ]);
  await prisma.user.create({ data: { email: 'admin@laguillotina.local', displayName: 'Administración', passwordHash: adminHash, role: 'ADMIN', preference: { create: {} } } });
  await prisma.user.create({ data: { email: 'prueba@laguillotina.local', displayName: 'Lectora', passwordHash: readerHash, role: 'READER', preference: { create: {} } } });
  const editor = await prisma.user.create({ data: { email: 'editor@laguillotina.local', displayName: 'Edición', passwordHash: editorHash, role: 'EDITOR', preference: { create: {} } } });
  const moderator = await prisma.user.create({ data: { email: 'moderador@laguillotina.local', displayName: 'Moderación', passwordHash: moderatorHash, role: 'MODERATOR', preference: { create: {} } } });
  editorId = editor.id;
  moderatorId = moderator.id;
  await prisma.siteSettings.create({ data: {
    id: 'default', brandName: 'La Guillotina', publicationType: 'Revista anarquista', statement: 'Contra toda autoridad',
    headerLine: 'REVISTA ANARQUISTA / CONTRA TODA AUTORIDAD', footerStatement: 'COPIÁ · DIFUNDÍ · ORGANIZATE',
    socialPrompt: 'SEGUÍ LA SEÑAL', navigation: [{ label: 'Inicio', to: '/', sortOrder: 0 }], socialLinks: [],
  } });
  const cover = await prisma.resource.create({ data: {
    type: 'IMAGE', storageDriver: 'EXTERNAL', name: 'Portada', url: 'https://example.org/cover.webp', alt: 'Portada de prueba',
    credit: 'La Guillotina', license: 'Prueba', status: 'PUBLISHED', uploadStatus: 'COMPLETE',
  } });
  const edition = await prisma.edition.create({ data: {
    slug: 'n-012-la-libertad', number: 12, title: 'La libertad no se pide', dateLabel: 'Mayo 2024', status: 'PUBLISHED',
    publishedAt: new Date(), coverResourceId: cover.id,
  } });
  editionId = edition.id;
  const note = await prisma.note.create({ data: {
    slug: 'freedom', title: 'La libertad no se pide', excerpt: 'Acción directa', bodyMarkdown: 'Primer párrafo.\n\nSegundo párrafo.',
    status: 'PUBLISHED', publishedAt: new Date(), editionId: edition.id, fragment: 'freedom', x: 100, y: 500, width: 300, height: 400,
  } });
  noteId = note.id;
  await prisma.resource.create({ data: {
    type: 'VIDEO', storageDriver: 'EXTERNAL', name: 'Video público', url: 'https://example.org/video.mp4', alt: 'Video de prueba',
    credit: 'Pruebas', license: 'CC0', status: 'PUBLISHED', uploadStatus: 'COMPLETE', mimeType: 'video/mp4',
  } });
  await prisma.edition.create({ data: {
    slug: 'libro-de-prueba', kind: 'BOOK', number: 1, title: 'Libro de prueba', author: 'La Guillotina', dateLabel: '2026',
    summary: 'Un libro publicado para el catálogo.', status: 'PUBLISHED', publishedAt: new Date(),
  } });
  app = await buildApp({ config, prisma, logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  await rm(storagePath, { recursive: true, force: true });
});

describe('autenticación y permisos', () => {
  it('autoriza preflight CORS para los métodos usados por el frontend local', async () => {
    const expectedMethods = ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      const response = await app.inject({
        method: 'OPTIONS',
        url: `${prefix}/admin/editions/${editionId}`,
        headers: {
          origin,
          'access-control-request-method': 'PATCH',
          'access-control-request-headers': 'content-type,x-csrf-token',
        },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe(origin);
      expect(response.headers['access-control-allow-credentials']).toBe('true');
      expect(response.headers['access-control-allow-methods']?.split(',').map(method => method.trim())).toEqual(expectedMethods);
      expect(response.headers['access-control-allow-headers']).toContain('x-csrf-token');
    }
  });

  it('registra una lectora, conserva sesión y actualiza el perfil con CSRF', async () => {
    const registration = await app.inject({ method: 'POST', url: `${prefix}/auth/register`, payload: { name: 'Nueva Lectora', email: 'nueva@example.org', password: 'una-clave-segura' } });
    expect(registration.statusCode).toBe(201);
    const body = registration.json();
    expect(body.user.role).toBe('reader');
    const cookie = sessionCookie(registration);
    const profile = await app.inject({ method: 'PATCH', url: `${prefix}/auth/profile`, headers: { cookie, 'x-csrf-token': body.csrfToken }, payload: { name: 'Nombre actualizado' } });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().name).toBe('Nombre actualizado');
  });

  it('inicia las cuentas seed y bloquea administración para reader', async () => {
    const reader = await login('prueba@laguillotina.local', 'guillotina');
    readerCookie = reader.cookie; readerCsrf = reader.csrfToken;
    const denied = await app.inject({ method: 'POST', url: `${prefix}/admin/categories`, headers: authHeaders(readerCookie, readerCsrf), payload: { name: 'Sin permiso', description: 'No debería crearse.', color: 'red' } });
    expect(denied.statusCode).toBe(403);
    const admin = await login('admin@laguillotina.local', 'guillotina-admin');
    adminCookie = admin.cookie; adminCsrf = admin.csrfToken;
    const dashboard = await app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?pageSize=5`, headers: { cookie: adminCookie } });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().pagination.notes.pageSize).toBe(5);
  });

  it('aplica permisos separados para edición, moderación y administración', async () => {
    const editor = await login('editor@laguillotina.local', 'guillotina-editor');
    editorCookie = editor.cookie; editorCsrf = editor.csrfToken;
    const moderator = await login('moderador@laguillotina.local', 'guillotina-moderator');
    moderatorCookie = moderator.cookie; moderatorCsrf = moderator.csrfToken;

    const editorCategory = await app.inject({
      method: 'POST', url: `${prefix}/admin/categories`, headers: authHeaders(editorCookie, editorCsrf),
      payload: { name: 'Categoría editorial', description: 'Creada por una cuenta editora.', color: 'cyan' },
    });
    expect(editorCategory.statusCode).toBe(201);
    const editorCannotModerate = await app.inject({
      method: 'PATCH', url: `${prefix}/admin/comments/00000000-0000-4000-8000-000000000099`,
      headers: authHeaders(editorCookie, editorCsrf), payload: { status: 'hidden' },
    });
    expect(editorCannotModerate.statusCode).toBe(403);
    const moderatorCannotEdit = await app.inject({
      method: 'POST', url: `${prefix}/admin/categories`, headers: authHeaders(moderatorCookie, moderatorCsrf),
      payload: { name: 'Categoría denegada', description: 'No debería existir.', color: 'red' },
    });
    expect(moderatorCannotEdit.statusCode).toBe(403);
    const moderationDashboard = await app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=comments`, headers: { cookie: moderatorCookie } });
    expect(moderationDashboard.statusCode).toBe(200);
    expect(moderationDashboard.json().editions).toEqual([]);
    const forbiddenUsers = await app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=users`, headers: { cookie: editorCookie } });
    expect(forbiddenUsers.statusCode).toBe(403);

    const target = await prisma.user.create({ data: {
      email: 'cambio-rol@example.org', displayName: 'Cambio de rol', passwordHash: await hashPassword('clave-cambio-rol'), role: 'READER',
    } });
    const roleChange = await app.inject({
      method: 'PATCH', url: `${prefix}/admin/users/${target.id}`, headers: authHeaders(adminCookie, adminCsrf), payload: { role: 'editor' },
    });
    expect(roleChange.statusCode).toBe(200);
    expect(roleChange.json().role).toBe('editor');
  });

  it('genera un correo de recuperación, consume una sola vez el token y revoca la clave anterior', async () => {
    await prisma.user.create({ data: {
      email: 'recuperar@example.org', displayName: 'Recuperar', passwordHash: await hashPassword('clave-anterior'), role: 'READER',
    } });
    const before = await mailboxMessages();
    const forgot = await app.inject({ method: 'POST', url: `${prefix}/auth/password/forgot`, payload: { email: 'recuperar@example.org' } });
    expect(forgot.statusCode).toBe(200);
    const after = await mailboxMessages();
    const message = after.find(item => item.kind === 'password_reset' && !before.some(previous => previous.messageId === item.messageId));
    expect(message).toBeDefined();
    const resetUrl = message!.text.match(/https?:\/\/\S+/)?.[0];
    const token = resetUrl ? new URL(resetUrl).searchParams.get('token') : null;
    expect(token).toBeTruthy();
    const reset = await app.inject({ method: 'POST', url: `${prefix}/auth/password/reset`, payload: { token, password: 'clave-nueva-segura' } });
    expect(reset.statusCode).toBe(200);
    const reused = await app.inject({ method: 'POST', url: `${prefix}/auth/password/reset`, payload: { token, password: 'otra-clave-segura' } });
    expect(reused.statusCode).toBe(400);
    const oldLogin = await app.inject({ method: 'POST', url: `${prefix}/auth/login`, payload: { email: 'recuperar@example.org', password: 'clave-anterior' } });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({ method: 'POST', url: `${prefix}/auth/login`, payload: { email: 'recuperar@example.org', password: 'clave-nueva-segura' } });
    expect(newLogin.statusCode).toBe(200);
  });
});

describe('configuración pública y catálogo', () => {
  it('publica configuración editable por administración o edición', async () => {
    const initial = await app.inject({ method: 'GET', url: `${prefix}/site/settings` });
    expect(initial.statusCode).toBe(200);
    expect(initial.json().brandName).toBe('La Guillotina');
    const updated = await app.inject({
      method: 'PATCH', url: `${prefix}/admin/settings`, headers: authHeaders(editorCookie, editorCsrf),
      payload: { socialPrompt: 'SEGUÍ LA TINTA' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().socialPrompt).toBe('SEGUÍ LA TINTA');
    const publicSettings = await app.inject({ method: 'GET', url: `${prefix}/site/settings` });
    expect(publicSettings.json().socialPrompt).toBe('SEGUÍ LA TINTA');
  });

  it('pagina y filtra revistas, libros, muestras y multimedia sin exponer borradores', async () => {
    const catalog = await app.inject({ method: 'GET', url: `${prefix}/catalog?page=1&pageSize=1` });
    expect(catalog.statusCode).toBe(200);
    expect(catalog.json().magazines).toHaveLength(1);
    expect(catalog.json().books).toHaveLength(1);
    expect(catalog.json().showcase).toHaveLength(1);
    expect(catalog.json().multimedia).toHaveLength(1);
    expect(catalog.json().pagination.multimedia.pageSize).toBe(1);
    const video = await app.inject({ method: 'GET', url: `${prefix}/catalog?section=multimedia&type=video&search=Video` });
    expect(video.statusCode).toBe(200);
    expect(video.json().multimedia[0]).toMatchObject({ type: 'video', name: 'Video público' });
    expect(video.json().magazines).toEqual([]);
  });
});

describe('notas, comentarios y puntuaciones', () => {
  it('devuelve la portada compatible y crea notas administrativas', async () => {
    const home = await app.inject({ method: 'GET', url: `${prefix}/editions/n-012-la-libertad/home` });
    expect(home.statusCode).toBe(200);
    expect(home.json().notes[0].paragraphs).toEqual(['Primer párrafo.', 'Segundo párrafo.']);
    const created = await app.inject({ method: 'POST', url: `${prefix}/admin/notes`, headers: authHeaders(adminCookie, adminCsrf), payload: {
      title: 'Nota de integración', excerpt: 'Una bajada válida', body: 'Contenido en Markdown.', status: 'draft', editionId,
      categoryIds: [], resourceIds: [], author: 'Pruebas', readingMinutes: 3,
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe('draft');
    const updated = await app.inject({
      method: 'PATCH', url: `${prefix}/admin/notes/${created.json().id}`, headers: authHeaders(adminCookie, adminCsrf),
      payload: { title: 'Nota de integración actualizada', status: 'review' },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ title: 'Nota de integración actualizada', status: 'review' });
    const titleOnly = await app.inject({
      method: 'PATCH', url: `${prefix}/admin/notes/${created.json().id}`, headers: authHeaders(adminCookie, adminCsrf),
      payload: { title: 'Nota actualizada sin reiniciar valores' },
    });
    expect(titleOnly.statusCode).toBe(200);
    expect(titleOnly.json()).toMatchObject({ title: 'Nota actualizada sin reiniciar valores', status: 'review', author: 'Pruebas', readingMinutes: 3 });
  });

  it('mantiene comentarios pendientes hasta moderación y hace el voto idempotente', async () => {
    const created = await app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments`, payload: { author: 'Anónima', body: 'Comentario que espera revisión.' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().status).toBe('pending');
    const hidden = await app.inject({ method: 'GET', url: `${prefix}/notes/freedom/comments` });
    expect(hidden.json()).toHaveLength(0);
    const commentId = created.json().id;
    const moderated = await app.inject({ method: 'PATCH', url: `${prefix}/admin/comments/${commentId}`, headers: authHeaders(adminCookie, adminCsrf), payload: { status: 'visible' } });
    expect(moderated.statusCode).toBe(200);
    const firstVote = await app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${commentId}/upvote` });
    expect(firstVote.json().votes).toBe(1);
    const voterCookie = namedCookie(firstVote, 'lg_voter');
    const secondVote = await app.inject({ method: 'POST', url: `${prefix}/notes/freedom/comments/${commentId}/upvote`, headers: { cookie: voterCookie } });
    expect(secondVote.json().votes).toBe(1);
  });

  it('permite corregir una única puntuación por cookie anónima', async () => {
    const first = await app.inject({ method: 'POST', url: `${prefix}/notes/freedom/rating`, payload: { score: 4 } });
    expect(first.json()).toEqual({ rating: 4, ratingsCount: 1 });
    const voterCookie = namedCookie(first, 'lg_voter');
    const correction = await app.inject({ method: 'POST', url: `${prefix}/notes/freedom/rating`, headers: { cookie: voterCookie }, payload: { score: 5 } });
    expect(correction.json()).toEqual({ rating: 5, ratingsCount: 1 });
  });

  it('registra una sola denuncia anónima y deriva el comentario a moderación', async () => {
    const comment = await prisma.comment.create({ data: {
      noteId, authorName: 'Visible', body: 'Comentario denunciable.', status: 'VISIBLE',
    } });
    const first = await app.inject({
      method: 'POST', url: `${prefix}/notes/freedom/comments/${comment.id}/report`,
      payload: { reason: 'abuse', detail: 'Contenido hostil.' },
    });
    expect(first.statusCode).toBe(202);
    const voterCookie = namedCookie(first, 'lg_voter');
    const repeated = await app.inject({
      method: 'POST', url: `${prefix}/notes/freedom/comments/${comment.id}/report`, headers: { cookie: voterCookie },
      payload: { reason: 'abuse', detail: 'Contenido hostil.' },
    });
    expect(repeated.statusCode).toBe(202);
    const stored = await prisma.comment.findUniqueOrThrow({ where: { id: comment.id }, include: { _count: { select: { reports: true } } } });
    expect(stored.status).toBe('REPORTED');
    expect(stored.reportCount).toBe(1);
    expect(stored._count.reports).toBe(1);
  });
});

describe('operaciones editoriales y borrado lógico', () => {
  it('numera ediciones concurrentes sin colisiones y permite archivarlas o eliminarlas lógicamente', async () => {
    const responses = await Promise.all(Array.from({ length: 4 }, (_, index) => app.inject({
      method: 'POST', url: `${prefix}/admin/editions`, headers: authHeaders(adminCookie, adminCsrf),
      payload: { title: `Edición concurrente ${index}`, date: 'Agosto 2026', status: 'draft', noteIds: [] },
    })));
    expect(responses.map(response => response.statusCode), responses.map(response => response.body).join('\n')).toEqual([201, 201, 201, 201]);
    const editions = responses.map(response => response.json());
    expect(new Set(editions.map(edition => edition.number)).size).toBe(4);
    const deleted = await app.inject({
      method: 'PATCH', url: `${prefix}/admin/editions/${editions[0].id}`, headers: authHeaders(adminCookie, adminCsrf), payload: { status: 'deleted' },
    });
    expect(deleted.statusCode).toBe(200);
    const stored = await prisma.edition.findUniqueOrThrow({ where: { id: editions[0].id } });
    expect(stored.deletedAt).toBeInstanceOf(Date);
  });

  it('crea, actualiza y elimina lógicamente categorías y recursos', async () => {
    const category = await app.inject({
      method: 'POST', url: `${prefix}/admin/categories`, headers: authHeaders(editorCookie, editorCsrf),
      payload: { name: 'Temporal', description: 'Categoría temporal para pruebas.', color: 'lime' },
    });
    expect(category.statusCode).toBe(201);
    const deletedCategory = await app.inject({
      method: 'PATCH', url: `${prefix}/admin/categories/${category.json().id}`, headers: authHeaders(editorCookie, editorCsrf),
      payload: { status: 'deleted' },
    });
    expect(deletedCategory.statusCode).toBe(200);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: category.json().id } })).deletedAt).toBeInstanceOf(Date);

    const resource = await app.inject({
      method: 'POST', url: `${prefix}/admin/resources`, headers: authHeaders(editorCookie, editorCsrf), payload: {
        type: 'pdf', name: 'Documento temporal', url: 'https://example.org/documento.pdf', alt: 'Documento de prueba',
        credit: 'Pruebas', license: 'CC0', status: 'published', mimeType: 'application/pdf',
      },
    });
    expect(resource.statusCode).toBe(201);
    const readOnlyMetadata = await app.inject({
      method: 'PATCH', url: `${prefix}/admin/resources/${resource.json().id}`, headers: authHeaders(editorCookie, editorCsrf),
      payload: { fileName: 'metadato-no-editable.pdf' },
    });
    expect(readOnlyMetadata.statusCode, readOnlyMetadata.body).toBe(400);
    expect(readOnlyMetadata.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    const deletedResource = await app.inject({
      method: 'PATCH', url: `${prefix}/admin/resources/${resource.json().id}`, headers: authHeaders(editorCookie, editorCsrf),
      payload: { status: 'deleted' },
    });
    expect(deletedResource.statusCode).toBe(200);
    expect((await prisma.resource.findUniqueOrThrow({ where: { id: resource.json().id } })).deletedAt).toBeInstanceOf(Date);
    const publicSearch = await app.inject({ method: 'GET', url: `${prefix}/catalog?section=multimedia&search=Documento%20temporal` });
    expect(publicSearch.json().multimedia).toEqual([]);

    const emptyCategoryPatch = await app.inject({
      method: 'PATCH', url: `${prefix}/admin/categories/${category.json().id}`, headers: authHeaders(editorCookie, editorCsrf), payload: {},
    });
    expect(emptyCategoryPatch.statusCode).toBe(400);
  });

  it('honra el filtro section y no consulta ni devuelve colecciones ajenas', async () => {
    const response = await app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=notes&pageSize=2`, headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().notes.length).toBeLessThanOrEqual(2);
    expect(response.json().editions).toEqual([]);
    expect(response.json().contacts).toEqual([]);
    expect(response.json().filters.section).toBe('notes');
  });
});

describe('archivo público', () => {
  it('pagina recursos publicados y filtra por tipos multimedia', async () => {
    await prisma.resource.createMany({ data: [
      { type: 'IMAGE', storageDriver: 'EXTERNAL', name: 'Foto pública', url: 'https://example.org/foto.webp', alt: 'Foto pública', credit: 'Pruebas', license: 'CC0', status: 'PUBLISHED', uploadStatus: 'COMPLETE' },
      { type: 'VIDEO', storageDriver: 'S3', name: 'Carga incompleta', url: '', alt: 'Video todavía incompleto', credit: 'Pruebas', license: 'CC0', status: 'PUBLISHED', uploadStatus: 'UPLOADING' },
    ] });
    const response = await app.inject({ method: 'GET', url: `${prefix}/resources?types=video&page=1&pageSize=1` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ type: 'video', name: 'Video público', uploadStatus: 'complete' }],
      pagination: { page: 1, pageSize: 1, total: 1 },
    });
  });
});

describe('contacto y correo', () => {
  it('guarda borradores y entrega respuestas por el proveedor de correo configurado', async () => {
    const created = await app.inject({ method: 'POST', url: `${prefix}/contacts`, payload: {
      name: 'Colectivo de prueba', email: 'colectivo@example.org', subject: 'Consulta editorial',
      body: 'Queremos saber cómo acercar una colaboración para el próximo número.',
    } });
    expect(created.statusCode).toBe(201);
    const contactId = created.json().id;
    const draft = await app.inject({
      method: 'PATCH', url: `${prefix}/admin/contacts/${contactId}`, headers: authHeaders(moderatorCookie, moderatorCsrf),
      payload: { status: 'in_progress', reply: 'Este texto todavía es un borrador.', send: false },
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().replyStatus).toBe('draft');

    const sent = await app.inject({
      method: 'PATCH', url: `${prefix}/admin/contacts/${contactId}`, headers: authHeaders(moderatorCookie, moderatorCsrf),
      payload: { status: 'answered', reply: 'Pueden enviar el material mediante el formulario de colaboración.' },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ status: 'answered', replyStatus: 'sent' });
    expect(sent.json().sentAt).toBeTruthy();
    const stored = await prisma.contactMessage.findUniqueOrThrow({ where: { id: contactId }, include: { replies: true } });
    expect(stored.status).toBe('ANSWERED');
    expect(stored.replies.map(reply => reply.status).sort()).toEqual(['DRAFT', 'SENT']);
    const messages = await mailboxMessages();
    expect(messages.some(message => message.kind === 'contact_reply' && message.to === 'colectivo@example.org')).toBe(true);
  });
});

describe('analítica anónima', () => {
  it('respeta señales de privacidad, anonimiza sesiones y agrega días cerrados', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1_000);
    yesterday.setUTCHours(12, 0, 0, 0);
    const sessionId = 'session-anonima-de-integracion-0001';
    const accepted = await app.inject({ method: 'POST', url: `${prefix}/analytics/events`, payload: {
      sessionId,
      events: [
        { type: 'page_view', editionSlug: 'n-012-la-libertad', noteId: 'freedom', source: 'https://google.com/search', occurredAt: yesterday.toISOString() },
        { type: 'reading_time', editionSlug: 'n-012-la-libertad', noteId: 'freedom', durationSeconds: 180, occurredAt: yesterday.toISOString() },
      ],
    } });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().accepted).toBe(2);
    const privateRequest = await app.inject({
      method: 'POST', url: `${prefix}/analytics/events`, headers: { 'sec-gpc': '1' },
      payload: { sessionId: 'otra-sesion-anonima-0002', events: [{ type: 'page_view' }] },
    });
    expect(privateRequest.json()).toMatchObject({ accepted: 0, privacySignalRespected: true });
    const raw = await prisma.analyticsEvent.findFirstOrThrow({ where: { type: 'READING_TIME' } });
    expect(raw.sessionHash).not.toBe(sessionId);
    expect(raw.sessionHash).toMatch(/^[a-f0-9]{64}$/);

    const denied = await app.inject({ method: 'POST', url: `${prefix}/internal/analytics/aggregate`, headers: { authorization: 'Bearer incorrecto' } });
    expect(denied.statusCode).toBe(401);
    const aggregated = await app.inject({
      method: 'POST', url: `${prefix}/internal/analytics/aggregate`, headers: { authorization: `Bearer ${config.cronSecret}` },
    });
    expect(aggregated.statusCode).toBe(200);
    expect(aggregated.json().aggregatedGroups).toBeGreaterThan(0);
    expect(await prisma.analyticsDaily.count()).toBeGreaterThan(0);
  });
});

describe('recursos', () => {
  it('sube un archivo local con sus metadatos obligatorios', async () => {
    const boundary = `----guillotina-${Date.now()}`;
    const payload = multipartBody(boundary, {
      type: 'image', name: 'Imagen mínima', alt: 'Un píxel de prueba', credit: 'Pruebas', license: 'CC0', status: 'draft',
    }, 'file', 'pixel.png', 'image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const response = await app.inject({
      method: 'POST', url: `${prefix}/admin/resources/upload`,
      headers: { ...authHeaders(adminCookie, adminCsrf), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ type: 'image', fileName: 'pixel.png', fileSize: 8, status: 'draft' });
  });

  it('completa el contrato S3 multipart con URLs firmadas y verificación final', async () => {
    const sendSpy = vi.spyOn(S3Client.prototype, 'send');
    sendSpy.mockImplementation((async (command: unknown) => {
      const name = (command as { constructor: { name: string } }).constructor.name;
      if (name === 'CreateMultipartUploadCommand') return { UploadId: 'provider-upload-1', $metadata: {} };
      if (name === 'CompleteMultipartUploadCommand') return { $metadata: {} };
      if (name === 'HeadObjectCommand') return { ContentLength: 20, ContentType: 'video/mp4', ETag: 'etag-final', $metadata: {} };
      if (name === 'AbortMultipartUploadCommand') return { $metadata: {} };
      throw new Error(`Comando S3 inesperado: ${name}`);
    }) as never);
    const s3Config = {
      ...config,
      storageDriver: 's3' as const,
      multipartThresholdBytes: 10,
      s3: {
        endpoint: 'http://127.0.0.1:9000', region: 'auto', bucket: 'guillotina-test',
        accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key', publicBaseUrl: 'https://cdn.example.org',
      },
    };
    const s3App = await buildApp({ config: s3Config, prisma, logger: false });
    try {
      await s3App.ready();
      const started = await s3App.inject({
        method: 'POST', url: `${prefix}/admin/resources/uploads`, headers: authHeaders(adminCookie, adminCsrf), payload: {
          type: 'video', name: 'Video multipart', alt: 'Video de integración', credit: 'Pruebas', license: 'CC0', status: 'draft',
          fileName: 'video.mp4', fileSize: 20, mimeType: 'video/mp4',
        },
      });
      expect(started.statusCode).toBe(201);
      expect(started.json().mode).toBe('multipart');
      const uploadId = started.json().uploadId;
      const part = await s3App.inject({
        method: 'POST', url: `${prefix}/admin/resources/uploads/${uploadId}/part`, headers: authHeaders(adminCookie, adminCsrf),
        payload: { partNumber: 1 },
      });
      expect(part.statusCode).toBe(200);
      expect(part.json().uploadUrl).toContain('provider-upload-1');
      const completed = await s3App.inject({
        method: 'POST', url: `${prefix}/admin/resources/uploads/${uploadId}/complete`, headers: authHeaders(adminCookie, adminCsrf),
        payload: { parts: [{ partNumber: 1, etag: 'etag-parte-1' }] },
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({ status: 'draft', url: expect.stringContaining('https://cdn.example.org/') });
      expect(sendSpy.mock.calls.map(call => (call[0] as { constructor: { name: string } }).constructor.name)).toEqual(expect.arrayContaining([
        'CreateMultipartUploadCommand', 'CompleteMultipartUploadCommand', 'HeadObjectCommand',
      ]));
    } finally {
      await s3App.close();
      sendSpy.mockRestore();
    }
  });
});

async function login(email: string, password: string) {
  const response = await app.inject({ method: 'POST', url: `${prefix}/auth/login`, payload: { email, password } });
  expect(response.statusCode).toBe(200);
  return { cookie: sessionCookie(response), csrfToken: response.json().csrfToken as string };
}

function authHeaders(cookie: string, csrfToken: string) {
  return { cookie, 'x-csrf-token': csrfToken };
}

function sessionCookie(response: { headers: Record<string, unknown> }) {
  return namedCookie(response, config.sessionCookieName);
}

function namedCookie(response: { headers: Record<string, unknown> }, name: string) {
  const values = response.headers['set-cookie'];
  const all = Array.isArray(values) ? values : [String(values ?? '')];
  const match = all.find(value => value.startsWith(`${name}=`));
  if (!match) throw new Error(`No se recibió la cookie ${name}.`);
  return match.split(';')[0]!;
}

function multipartBody(boundary: string, fields: Record<string, string>, fileField: string, fileName: string, mimeType: string, file: Buffer) {
  const chunks: Buffer[] = [];
  const line = (value: string) => chunks.push(Buffer.from(value, 'utf8'));
  line(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`);
  chunks.push(file); line('\r\n');
  for (const [name, value] of Object.entries(fields)) line(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  line(`--${boundary}--\r\n`);
  return Buffer.concat(chunks);
}

type DevelopmentMail = { messageId: string; kind: 'password_reset' | 'contact_reply'; to: string; subject: string; text: string };

async function mailboxMessages(): Promise<DevelopmentMail[]> {
  try {
    const files = (await readdir(mailboxPath)).filter(file => file.endsWith('.json'));
    return Promise.all(files.map(async file => JSON.parse(await readFile(`${mailboxPath}/${file}`, 'utf8')) as DevelopmentMail));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
