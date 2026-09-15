import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders, closeTestDatabase, createTestContext, ids, login, multipartBody, prefix, prisma, storedFiles, type TestContext,
} from './helpers/test-context.js';

let context: TestContext;
beforeEach(async () => { context = await createTestContext(); });
afterEach(async () => { await context.app.close(); });
afterAll(closeTestDatabase);

describe('almacenamiento local empírico', () => {
  it('escribe bytes reales, registra metadatos y sirve el archivo por la API', async () => {
    const admin = await login(context.app, 'admin');
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const boundary = `----guillotina-${Date.now()}`;
    const payload = multipartBody(boundary, {
      type: 'image', name: 'Imagen empírica', alt: 'Archivo binario de prueba', credit: 'Suite', license: 'CC0', status: 'published',
    }, 'file', 'pixel.png', 'image/png', bytes);
    const response = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/upload`, headers: { ...authHeaders(admin), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ type: 'image', fileName: 'pixel.png', fileSize: bytes.length, mimeType: 'image/png', storageDriver: 'local', uploadStatus: 'complete' });
    const resource = await prisma.resource.findUniqueOrThrow({ where: { id: response.json().id } });
    expect(resource.objectKey).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]+\.png$/);
    const files = (await storedFiles()).filter(file => !file.path.includes('mailbox'));
    expect(files).toHaveLength(1);
    expect(files[0]!.size).toBe(bytes.length);
    const mediaUrl = new URL(response.json().url).pathname;
    const media = await context.app.inject({ method: 'GET', url: mediaUrl });
    expect(media.statusCode).toBe(200);
    expect(media.headers['content-type']).toContain('image/png');
    expect(media.rawPayload).toEqual(bytes);
  });

  it('rechaza tipo declarado inconsistente y elimina el archivo parcial', async () => {
    const admin = await login(context.app, 'admin');
    const boundary = `----guillotina-${Date.now()}`;
    const payload = multipartBody(boundary, { type: 'pdf', name: 'Tipo falso', alt: 'No es PDF', credit: 'Suite', license: 'CC0', status: 'draft' }, 'file', 'falso.png', 'image/png', Buffer.from('contenido-no-pdf'));
    const response = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/upload`, headers: { ...authHeaders(admin), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(await prisma.resource.count({ where: { name: 'Tipo falso' } })).toBe(0);
    expect((await storedFiles()).filter(file => !file.path.includes('mailbox'))).toEqual([]);
  });

  it('aplica límites diferentes y limpia archivos demasiado grandes', async () => {
    await context.app.close();
    context = await createTestContext({ maxDefaultFileBytes: 10, maxVideoBytes: 30 });
    const editor = await login(context.app, 'editor');
    const boundary = `----guillotina-${Date.now()}`;
    const payload = multipartBody(boundary, { type: 'image', name: 'Imagen grande', alt: 'Supera el máximo', credit: 'Suite', license: 'CC0', status: 'draft' }, 'file', 'grande.png', 'image/png', Buffer.alloc(11, 1));
    const response = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/upload`, headers: { ...authHeaders(editor), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(response.statusCode).toBe(413);
    expect(response.json().error.code).toBe('FILE_TOO_LARGE');
    expect((await storedFiles()).filter(file => !file.path.includes('mailbox'))).toEqual([]);

    const videoBoundary = `----guillotina-video-${Date.now()}`;
    const videoBytes = Buffer.alloc(20, 2);
    const videoPayload = multipartBody(videoBoundary, { type: 'video', name: 'Video permitido', alt: 'Dentro del límite de video', credit: 'Suite', license: 'CC0', status: 'draft' }, 'file', 'video.mp4', 'video/mp4', videoBytes);
    const video = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/upload`, headers: { ...authHeaders(editor), 'content-type': `multipart/form-data; boundary=${videoBoundary}` }, payload: videoPayload });
    expect(video.statusCode).toBe(201);
    expect(video.json().fileSize).toBe(20);
  });

  it('no consume ni persiste archivos sin rol, CSRF o metadatos válidos', async () => {
    const boundary = `----guillotina-${Date.now()}`;
    const payload = multipartBody(boundary, { type: 'image', name: 'Sin permiso', alt: 'No debe persistirse', credit: 'Suite', license: 'CC0', status: 'draft' }, 'file', 'x.png', 'image/png', Buffer.from('bytes'));
    const anonymous = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/upload`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(anonymous.statusCode).toBe(401);
    const reader = await login(context.app, 'reader');
    const denied = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/upload`, headers: { ...authHeaders(reader), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload });
    expect(denied.statusCode).toBe(403);
    const admin = await login(context.app, 'admin');
    const missingBoundary = `----guillotina-missing-${Date.now()}`;
    const missingPayload = multipartBody(missingBoundary, { type: 'image', name: 'Sin créditos', alt: 'Faltan datos', license: 'CC0', status: 'draft' }, 'file', 'x.png', 'image/png', Buffer.from('bytes'));
    const invalid = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/upload`, headers: { ...authHeaders(admin), 'content-type': `multipart/form-data; boundary=${missingBoundary}` }, payload: missingPayload });
    expect(invalid.statusCode).toBe(400);
    expect(await prisma.resource.count({ where: { name: { in: ['Sin permiso', 'Sin créditos'] } } })).toBe(0);
    expect((await storedFiles()).filter(file => !file.path.includes('mailbox'))).toEqual([]);
  });
});

describe('agregación y dashboard analítico', () => {
  it('protege el cron, agrega días cerrados y elimina crudos según retención', async () => {
    await context.app.close();
    context = await createTestContext({ analyticsRawRetentionDays: 1 });
    const old = new Date(Date.now() - 3 * 86_400_000);
    const startOfTodayUtc = new Date();
    startOfTodayUtc.setUTCHours(0, 0, 0, 0);
    const yesterday = new Date(startOfTodayUtc.getTime() - 1);
    await prisma.analyticsEvent.createMany({ data: [
      { type: 'PAGE_VIEW', sessionHash: 'a'.repeat(64), noteId: ids.note, editionId: ids.edition, occurredAt: old },
      { type: 'PAGE_VIEW', sessionHash: 'b'.repeat(64), noteId: ids.note, editionId: ids.edition, occurredAt: yesterday },
      { type: 'READING_TIME', sessionHash: 'b'.repeat(64), noteId: ids.note, durationSeconds: 120, occurredAt: yesterday },
    ] });
    const missing = await context.app.inject({ method: 'POST', url: `${prefix}/internal/analytics/aggregate` });
    expect(missing.statusCode).toBe(401);
    const wrong = await context.app.inject({ method: 'POST', url: `${prefix}/internal/analytics/aggregate`, headers: { authorization: 'Bearer incorrecto' } });
    expect(wrong.statusCode).toBe(401);
    const response = await context.app.inject({ method: 'POST', url: `${prefix}/internal/analytics/aggregate`, headers: { authorization: `Bearer ${context.config.cronSecret}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json().aggregatedGroups).toBeGreaterThan(0);
    expect(response.json().removedRawEvents).toBe(1);
    expect(await prisma.analyticsDaily.count()).toBeGreaterThanOrEqual(3);
    expect(await prisma.analyticsEvent.count()).toBe(2);
    const rerun = await context.app.inject({ method: 'POST', url: `${prefix}/internal/analytics/aggregate`, headers: { authorization: `Bearer ${context.config.cronSecret}` } });
    expect(rerun.statusCode).toBe(200);
    const uniqueKeys = await prisma.analyticsDaily.findMany({ select: { day: true, type: true, dimensionKey: true } });
    expect(new Set(uniqueKeys.map(row => `${row.day.toISOString()}|${row.type}|${row.dimensionKey}`)).size).toBe(uniqueKeys.length);
  });

  it('calcula resumen, evolución, atención, fuentes y notas destacadas desde filas reales', async () => {
    const today = new Date();
    await prisma.analyticsEvent.createMany({ data: [
      { type: 'PAGE_VIEW', sessionHash: 'a'.repeat(64), noteId: ids.note, occurredAt: today, sourceCategory: 'direct' },
      { type: 'PAGE_VIEW', sessionHash: 'b'.repeat(64), noteId: ids.note, occurredAt: today, sourceCategory: 'search' },
      { type: 'READING_STARTED', sessionHash: 'a'.repeat(64), noteId: ids.note, occurredAt: today },
      { type: 'READING_COMPLETED', sessionHash: 'a'.repeat(64), noteId: ids.note, occurredAt: today },
      { type: 'READING_TIME', sessionHash: 'a'.repeat(64), noteId: ids.note, occurredAt: today, durationSeconds: 180 },
      { type: 'ATTENTION', sessionHash: 'a'.repeat(64), noteId: ids.note, occurredAt: today, segment: 'Final', progressPercent: 90 },
      { type: 'DOWNLOAD', sessionHash: 'a'.repeat(64), resourceId: ids.video, occurredAt: today },
    ] });
    await prisma.noteRating.create({ data: { noteId: ids.note, voterKey: 'dashboard-user', score: 5 } });
    const admin = await login(context.app, 'admin');
    const response = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=analytics&from=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`, headers: { cookie: admin.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().analytics.summary).toMatchObject({ visits: 2, uniqueReaders: 2, completedReads: 1, avgReadingSeconds: 180, downloads: 1, comments: 1, ratings: 1, avgRating: 5 });
    expect(response.json().analytics.timeline).toEqual([expect.objectContaining({ visits: 2, reads: 1 })]);
    expect(response.json().analytics.topNotes[0]).toMatchObject({ noteId: ids.note, visits: 2, completion: 100, rating: 5 });
    expect(response.json().analytics.attention).toEqual([{ label: 'Final', value: 90 }]);
    expect(response.json().analytics.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: 'Directo', count: 1 }), expect.objectContaining({ label: 'Búsqueda', count: 1 }),
    ]));
  });

  it('devuelve analítica vacía coherente cuando el rol o período no tiene eventos', async () => {
    const editor = await login(context.app, 'editor');
    const response = await context.app.inject({ method: 'GET', url: `${prefix}/admin/dashboard?section=analytics&from=2099-01-01T00:00:00.000Z`, headers: { cookie: editor.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json().analytics.summary).toEqual({ visits: 0, uniqueReaders: 0, completedReads: 0, avgReadingSeconds: 0, downloads: 0, comments: 0, ratings: 0, avgRating: 0 });
    expect(response.json().analytics.timeline).toEqual([]);
    expect(response.json().analytics.attention).toEqual([
      { label: 'Inicio', value: 0 }, { label: 'Primer tercio', value: 0 }, { label: 'Segundo tercio', value: 0 }, { label: 'Final', value: 0 },
    ]);
  });
});
