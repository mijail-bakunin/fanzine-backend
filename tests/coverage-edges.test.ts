import { createServer, type Server } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { Readable } from 'node:stream';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '../src/generated/prisma/client.js';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/build-app.js';
import { AppError, conflict, notFound, toHttpError } from '../src/lib/errors.js';
import { createPrismaClient } from '../src/lib/prisma.js';
import { enrichOpenApi } from '../src/openapi/documentation.js';
import { safeDeliveryError, statusDates } from '../src/modules/admin/admin.routes.js';
import { safeModerationMailError, serializeCommentEmailDelivery } from '../src/modules/admin/comment-moderation.js';
import { getDashboard, isAllowed } from '../src/modules/admin/dashboard.service.js';
import { countValue, formatAttention, sourceLabel } from '../src/modules/analytics/dashboard-analytics.js';
import { currentPasswordOrEmpty } from '../src/modules/auth/auth.routes.js';
import { paragraphsFromMarkdown, serializeComment, serializeResource } from '../src/modules/content/serializers.js';
import { serializeRatingAggregate } from '../src/modules/content/public.routes.js';
import { fieldValue } from '../src/modules/resources/resource.routes.js';
import { sendCommentRemoval, sendContactReply, sendPasswordReset } from '../src/services/mailer.js';
import { objectKeyFor, StorageService } from '../src/services/storage.js';
import {
  authHeaders, baseConfig, closeTestDatabase, createTestContext, ids, login, mailboxMessages, multipartBody, prefix, prisma, resetDatabase, storagePath, type TestContext,
} from './helpers/test-context.js';

let context: TestContext;
beforeEach(async () => { context = await createTestContext(); });
afterEach(async () => { await context.app.close(); });
afterAll(closeTestDatabase);

describe('errores y defensas de infraestructura', () => {
  it('normaliza todas las familias de errores sin filtrar mensajes internos', async () => {
    expect(notFound()).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', message: 'No encontramos el recurso solicitado.' });
    expect(notFound('Ausente')).toMatchObject({ message: 'Ausente' });
    expect(conflict('Duplicado', { field: 'slug' })).toMatchObject({ statusCode: 409, details: { field: 'slug' } });
    expect(toHttpError(new AppError(418, 'TEAPOT', 'Tetera'))).toMatchObject({ statusCode: 418, code: 'TEAPOT' });
    expect(toHttpError(z.string().min(3).safeParse('x').error)).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
    expect(toHttpError({ statusCode: 429 })).toMatchObject({ statusCode: 429, code: 'RATE_LIMIT_EXCEEDED' });
    expect(toHttpError({ statusCode: 413 })).toMatchObject({ statusCode: 413, code: 'PAYLOAD_TOO_LARGE' });
    expect(toHttpError({ statusCode: 418, code: 'CUSTOM_CODE', message: 'Controlado' })).toMatchObject({ statusCode: 418, code: 'CUSTOM_CODE', message: 'Controlado' });
    expect(toHttpError({ statusCode: 418, code: 'bad-code', message: '' })).toMatchObject({ code: 'HTTP_418', message: 'No fue posible procesar el pedido.' });
    expect(toHttpError({ statusCode: 500, code: 'UPSTREAM_SECRET', message: 'secreto interno' })).toMatchObject({ code: 'UPSTREAM_SECRET', message: 'Ocurrió un error interno inesperado.' });
    expect(toHttpError(new Error('Origen no permitido por CORS.'))).toMatchObject({ statusCode: 403, code: 'CORS_ORIGIN_DENIED' });
    for (const value of [null, 'error', { statusCode: 399 }, { statusCode: 600 }, { statusCode: 400.5 }, new Error('boom')]) {
      expect(toHttpError(value)).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
    }
    let unknownPrisma: unknown;
    try { await prisma.$queryRawUnsafe('SELECT * FROM tabla_que_no_existe'); } catch (error) { unknownPrisma = error; }
    expect(unknownPrisma).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(toHttpError(unknownPrisma)).toMatchObject({ statusCode: 500, code: 'INTERNAL_ERROR' });
  });

  it('clasifica P2025 y P2003 producidos realmente por PostgreSQL/Prisma', async () => {
    let missingError: unknown;
    try { await prisma.comment.update({ where: { id: '99999999-9999-4999-8999-999999999999' }, data: { body: 'x' } }); } catch (error) { missingError = error; }
    expect(missingError).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(toHttpError(missingError)).toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });

    let relationError: unknown;
    try { await prisma.category.delete({ where: { id: ids.category } }); } catch (error) { relationError = error; }
    expect(relationError).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(toHttpError(relationError)).toMatchObject({ statusCode: 409, code: 'RELATION_CONFLICT' });
  });

  it('persiste errores 500 y sobrevive empíricamente si también falla la tabla de logs', async () => {
    await context.app.close();
    const app = await buildApp({ config: context.config, prisma, logger: false });
    app.get('/test/internal-error', async () => { throw new Error('fallo intencional de prueba'); });
    let response = await app.inject({ method: 'GET', url: '/test/internal-error' });
    expect(response.statusCode).toBe(500);
    expect(await prisma.errorLog.count({ where: { requestId: response.json().error.requestId } })).toBe(1);
    await prisma.$executeRawUnsafe('ALTER TABLE error_logs RENAME TO error_logs_unavailable');
    try {
      response = await app.inject({ method: 'GET', url: '/test/internal-error' });
      expect(response.statusCode).toBe(500);
      expect(response.json().error).toMatchObject({ code: 'INTERNAL_ERROR' });
    } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE error_logs_unavailable RENAME TO error_logs');
      await app.close();
      context = await createTestContext();
    }
  });
});

describe('almacenamiento local y configuración S3', () => {
  it('codifica URLs, bloquea traversal y limpia escrituras interrumpidas reales', async () => {
    const storage = new StorageService(context.config);
    expect(storage.driver).toBe('local');
    expect(storage.publicUrl('carpeta/archivo con espacio.png')).toContain('archivo%20con%20espacio.png');
    await expect(storage.saveLocal('../escape.txt', Readable.from('no'))).rejects.toMatchObject({ code: 'INVALID_OBJECT_KEY' });
    await expect(storage.signPut('x', 'text/plain')).rejects.toMatchObject({ code: 'S3_STORAGE_REQUIRED' });
    const key = 'failures/interrumpido.bin';
    const broken = new Readable({
      read() { this.push(Buffer.from('parcial')); this.destroy(new Error('stream interrumpido')); },
    });
    await expect(storage.saveLocal(key, broken)).rejects.toThrow('stream interrumpido');
    await expect(access(path.resolve(storagePath, key))).rejects.toMatchObject({ code: 'ENOENT' });
    await storage.deleteLocal('../escape.txt');
  });

  it('rechaza cada secreto S3 faltante y la URL pública ausente', () => {
    const validS3 = { endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', bucket: 'laguillotina-test', accessKeyId: 'guillotina_test', secretAccessKey: 'guillotina_test_secret', publicBaseUrl: 'http://127.0.0.1:9000/laguillotina-test' };
    for (const key of ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'] as const) {
      const s3 = { ...validS3, [key]: undefined };
      expect(() => new StorageService({ ...context.config, storageDriver: 's3', s3 })).toThrowError(expect.objectContaining({ code: 'STORAGE_NOT_CONFIGURED' }));
    }
    const storage = new StorageService({ ...context.config, storageDriver: 's3', s3: { ...validS3, publicBaseUrl: undefined } });
    expect(() => storage.publicUrl('x.png')).toThrowError(expect.objectContaining({ code: 'STORAGE_PUBLIC_URL_MISSING' }));
  });

  it('rechaza operaciones locales sobre S3 sin modificar disco', async () => {
    const storage = new StorageService({ ...context.config, storageDriver: 's3', s3: {
      endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', bucket: 'laguillotina-test', accessKeyId: 'guillotina_test', secretAccessKey: 'guillotina_test_secret', publicBaseUrl: 'http://127.0.0.1:9000/laguillotina-test',
    } });
    await expect(storage.saveLocal('x.txt', Readable.from('x'))).rejects.toMatchObject({ code: 'DIRECT_UPLOAD_REQUIRED' });
    await expect(storage.deleteLocal('x.txt')).resolves.toBeUndefined();
  });

  it('genera claves opacas conservando sólo extensiones saneadas', () => {
    const png = objectKeyFor('FOTO.PNG');
    const noExtension = objectKeyFor('archivo');
    const unsafe = objectKeyFor('foto.<script>.MUY-LARGA');
    expect(png).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]+\.png$/);
    expect(noExtension).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]+$/);
    expect(path.extname(unsafe).length).toBeLessThanOrEqual(12);
    expect(unsafe).not.toContain('<');
  });

  it('detecta empíricamente un proveedor S3 malformado y headers HEAD ausentes', async () => {
    const provider = createHttpServer((request, response) => {
      if (request.method === 'HEAD') {
        response.statusCode = 200;
        response.end();
        return;
      }
      response.statusCode = 200;
      response.setHeader('content-type', 'application/xml');
      response.end('<?xml version="1.0" encoding="UTF-8"?><InitiateMultipartUploadResult><Bucket>fault</Bucket><Key>x</Key></InitiateMultipartUploadResult>');
    });
    await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
    const address = provider.address();
    if (!address || typeof address === 'string') throw new Error('Proveedor sin puerto.');
    const storage = new StorageService({ ...context.config, storageDriver: 's3', s3: {
      endpoint: `http://127.0.0.1:${address.port}`, region: 'us-east-1', bucket: 'fault', accessKeyId: 'key', secretAccessKey: 'secret', publicBaseUrl: `http://127.0.0.1:${address.port}/fault`,
    } });
    try {
      await expect(storage.createMultipart('x', 'application/octet-stream')).rejects.toMatchObject({ code: 'STORAGE_UPLOAD_FAILED' });
      expect(await storage.head('x')).toEqual({ size: 0, mimeType: null, etag: null });
    } finally { await new Promise<void>(resolve => provider.close(() => resolve())); }
  });
});

describe('bordes multipart locales', () => {
  it('rechaza el flujo firmado en local y multipart sin archivo', async () => {
    const editor = await login(context.app, 'editor');
    expect((await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads`, headers: authHeaders(editor), payload: {} })).statusCode).toBe(409);
    const boundary = 'sin-archivo';
    const noFile = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/upload`, headers: { ...authHeaders(editor), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: Buffer.from(`--${boundary}--\r\n`) });
    expect(noFile.statusCode).toBe(400);
    expect(noFile.json().error.code).toBe('FILE_REQUIRED');
  });

  it('guarda fecha explícita y conserva el último valor de campos duplicados', async () => {
    const editor = await login(context.app, 'editor');
    const boundary = 'duplicados';
    const prefixBody = multipartBody(boundary, {
      type: 'image', name: 'Nombre definitivo', alt: 'Imagen válida', credit: 'Suite', license: 'CC0', status: 'published', date: '2030-01-02T03:04:05.000Z',
    }, 'file', 'fecha.png', 'image/png', Buffer.from([1, 2, 3]));
    const duplicate = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nNombre previo\r\n`);
    const body = Buffer.concat([prefixBody.subarray(0, prefixBody.length - Buffer.byteLength(`--${boundary}--\r\n`)), duplicate, Buffer.from(`--${boundary}--\r\n`)]);
    const response = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/upload`, headers: { ...authHeaders(editor), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(response.statusCode).toBe(201);
    expect(new Date(response.json().date).toISOString()).toBe('2030-01-02T03:04:05.000Z');
  });

  it('rechaza empíricamente un stream truncado por el límite multipart', async () => {
    await context.app.close();
    context = await createTestContext({ maxVideoBytes: 8, maxDefaultFileBytes: 8 });
    const editor = await login(context.app, 'editor');
    const boundary = 'truncado';
    const body = multipartBody(boundary, { type: 'image', name: 'Muy grande', alt: 'Muy grande', credit: 'Suite', license: 'CC0' }, 'file', 'grande.png', 'image/png', Buffer.alloc(32, 1));
    const response = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/upload`, headers: { ...authHeaders(editor), 'content-type': `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(response.statusCode).toBe(413);
  });
});

describe('correo de desarrollo y SMTP real', () => {
  it('genera ambos asuntos de contacto sin duplicar Re:', async () => {
    await sendContactReply(context.config, { to: 'a@example.org', contactName: 'A', originalSubject: 'Consulta', body: 'Respuesta' });
    await sendContactReply(context.config, { to: 'b@example.org', contactName: 'B', originalSubject: 'RE: Consulta', body: 'Otra' });
    const messages = await mailboxMessages();
    expect(messages.map(message => message.subject).sort()).toEqual(['RE: Consulta', 'Re: Consulta']);
  });

  it('genera el aviso de moderación HTML escapado en el buzón de desarrollo', async () => {
    await sendCommentRemoval(context.config, { to: 'lector@example.org', displayName: '<Alias & Co>', reason: 'Uso de "datos" y contenido\' privado.' });
    const [message] = await mailboxMessages();
    expect(message).toMatchObject({ kind: 'comment_removal', to: 'lector@example.org', imageUrl: context.config.mail.moderationImageUrl });
    expect(message!.html).toContain('&lt;Alias &amp; Co&gt;');
    expect(message!.html).toContain('&quot;datos&quot; y contenido&#39; privado.');
    expect(message!.html).not.toContain('<Alias & Co>');
  });

  it('rechaza SMTP incompleto para recuperación y respuestas', async () => {
    const smtp = { ...context.config, mail: { ...context.config.mail, mode: 'smtp' as const } };
    await expect(sendPasswordReset(smtp, { to: 'a@example.org', displayName: 'A', resetUrl: 'https://example.org/reset' })).rejects.toMatchObject({ code: 'MAIL_NOT_CONFIGURED' });
    await expect(sendContactReply(smtp, { to: 'a@example.org', contactName: 'A', originalSubject: 'Tema', body: 'Texto' })).rejects.toMatchObject({ code: 'MAIL_NOT_CONFIGURED' });
    await expect(sendCommentRemoval(smtp, { to: 'a@example.org', displayName: 'A', reason: 'Motivo' })).rejects.toMatchObject({ code: 'MAIL_NOT_CONFIGURED' });
  });

  it('entrega recuperación y contacto por una conversación SMTP TCP real', async () => {
    const received: string[] = [];
    const server = await startSmtpServer(received);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('SMTP sin puerto TCP.');
    const config = { ...context.config, mail: {
      ...context.config.mail, mode: 'smtp' as const, smtpHost: '127.0.0.1', smtpPort: address.port,
      smtpUser: 'usuario', smtpPassword: 'clave', smtpFrom: 'La Guillotina <no-reply@laguillotina.local>',
    } };
    try {
      const reset = await sendPasswordReset(config, { to: 'a@example.org', displayName: 'A', resetUrl: 'https://example.org/reset' });
      const reply = await sendContactReply(config, { to: 'b@example.org', contactName: 'B', originalSubject: 'Tema', body: 'Respuesta SMTP' });
      const removal = await sendCommentRemoval(config, { to: 'c@example.org', displayName: 'C', reason: 'Motivo', imageUrl: 'https://example.org/moderation.png' });
      expect(reset.mode).toBe('smtp'); expect(reply.mode).toBe('smtp'); expect(removal.mode).toBe('smtp');
      expect(received.join('\n')).toContain('a@example.org');
      expect(received.join('\n')).toContain('b@example.org');
      expect(received.join('\n')).toContain('c@example.org');
      await context.app.close();
      context = await createTestContext({ mail: {
        mode: 'smtp', smtpHost: '127.0.0.1', smtpPort: address.port, smtpUser: 'usuario', smtpPassword: 'clave',
        smtpFrom: 'La Guillotina <no-reply@laguillotina.local>',
      } });
      await prisma.comment.update({ where: { id: ids.comment }, data: { userId: ids.reader } });
      const moderator = await login(context.app, 'moderator');
      const moderated = await context.app.inject({
        method: 'PATCH', url: `${prefix}/admin/comments/${ids.comment}`, headers: authHeaders(moderator), payload: { status: 'deleted' },
      });
      expect(moderated.statusCode).toBe(200);
      expect(moderated.json()).toMatchObject({ status: 'deleted', emailDelivery: { status: 'sent', messageId: expect.any(String), error: null } });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('ejecuta la configuración SMTPS y propaga una conexión real rechazada', async () => {
    const config = { ...context.config, mail: {
      ...context.config.mail, mode: 'smtp' as const, smtpHost: '127.0.0.1', smtpPort: 465,
      smtpUser: 'usuario', smtpPassword: 'clave', smtpFrom: 'no-reply@laguillotina.local',
    } };
    await expect(sendPasswordReset(config, { to: 'a@example.org', displayName: 'A', resetUrl: 'https://example.org' })).rejects.toBeInstanceOf(Error);
  });
});

describe('serializadores, OpenAPI y configuración de aplicación', () => {
  it('cubre valores opcionales sin inventar datos', () => {
    expect(paragraphsFromMarkdown('\nUno\n\n  \n\nDos\n')).toEqual(['Uno', 'Dos']);
    const now = new Date('2026-01-01T00:00:00Z');
    expect(serializeResource({ id: ids.image, type: 'IMAGE', name: 'x', url: 'https://x', alt: 'a', credit: 'c', license: 'l', status: 'PUBLISHED', uploadStatus: 'COMPLETE', fileName: null, fileSize: 0, mimeType: null, storageDriver: 'EXTERNAL', resourceDate: now, createdAt: now, updatedAt: now, width: 10, height: 20 })).toMatchObject({ fileName: '', width: 10, height: 20 });
    expect(serializeComment({ id: ids.comment, userId: ids.reader, authorName: 'A', body: 'B', status: 'VISIBLE', createdAt: now })).toMatchObject({ votes: 0, isAnonymous: false, authorType: 'account' });
    expect(serializeComment({ id: ids.comment, userId: null, authorName: 'Visitante', body: 'Privado', status: 'DELETED', createdAt: now })).toMatchObject({ author: 'Anónima', body: '', status: 'deleted', isAnonymous: true });
    expect(serializeCommentEmailDelivery({ moderationEmailStatus: null, moderationEmailMessageId: null, moderationEmailError: null })).toBeNull();
    expect(serializeCommentEmailDelivery({ moderationEmailStatus: 'FAILED', moderationEmailMessageId: null, moderationEmailError: 'MAIL' })).toEqual({ status: 'failed', messageId: null, error: 'MAIL' });
    expect(safeModerationMailError(new AppError(503, 'MAIL_DISABLED', 'No'))).toBe('MAIL_DISABLED');
    expect(safeModerationMailError(new Error('socket secreto'))).toBe('MAIL_DELIVERY_FAILED');
  });

  it('detecta operaciones ausentes y tolera entradas no operativas del documento', () => {
    expect((enrichOpenApi({}) as { 'x-documentation'?: unknown })['x-documentation']).toBeDefined();
    const document = enrichOpenApi({ paths: {
      '/null': undefined,
      '/mixed': { parameters: [], get: { responses: {} }, trace: null } as never,
      '/unknown': { get: { responses: {} } },
    } });
    expect((document as { 'x-documentation': { undocumentedOperations: string[] } })['x-documentation'].undocumentedOperations).toContain('GET /unknown');
  });

  it('verifica helpers de fallback con entradas de borde explícitas', () => {
    expect(statusDates(undefined)).toMatchObject({ publishedAt: undefined, archivedAt: undefined, deletedAt: undefined });
    expect(safeDeliveryError('rechazo no Error')).toBe('Error de entrega no identificado.');
    expect(safeDeliveryError(new Error('x'.repeat(1_500)))).toHaveLength(1_000);
    expect(isAllowed('READER', 'notes')).toBe(false);
    expect(countValue([])).toBe(0);
    expect(countValue([{ value: 3 }])).toBe(3);
    expect(formatAttention([{ segment: null, value: null }])).toEqual([{ label: 'Sin tramo', value: 0 }]);
    expect(formatAttention([])).toHaveLength(4);
    expect(sourceLabel(null)).toBe('Directo');
    expect(sourceLabel('desconocida')).toBe('Otros');
    expect(currentPasswordOrEmpty()).toBe('');
    expect(currentPasswordOrEmpty('actual')).toBe('actual');
    expect(serializeRatingAggregate(null, 0)).toEqual({ rating: 0, ratingsCount: 0 });
    expect(serializeRatingAggregate(4.26, 2)).toEqual({ rating: 4.3, ratingsCount: 2 });
    expect(fieldValue([{ value: 'primero' }, { value: null }])).toBe('');
    expect(fieldValue(null)).toBe('');
  });

  it('prohíbe filesystem en producción y construye S3 con logger real', async () => {
    await expect(buildApp({ config: { ...context.config, nodeEnv: 'production' }, prisma, logger: false })).rejects.toThrow('STORAGE_DRIVER=local');
    const app = await buildApp({ config: { ...context.config, nodeEnv: 'production', storageDriver: 's3', s3: {
      endpoint: 'http://127.0.0.1:9000', region: 'us-east-1', bucket: 'laguillotina-test', accessKeyId: 'guillotina_test', secretAccessKey: 'guillotina_test_secret', publicBaseUrl: 'http://127.0.0.1:9000/laguillotina-test',
    } }, prisma });
    await app.ready();
    expect((await app.inject({ method: 'GET', url: `${prefix}/health` })).statusCode).toBe(200);
    await app.close();
  });

  it('crea y reutiliza Prisma global sólo fuera de test', async () => {
    const previous = process.env.NODE_ENV;
    const globalScope = globalThis as typeof globalThis & { guillotinaPrisma?: ReturnType<typeof createPrismaClient> };
    const priorGlobal = globalScope.guillotinaPrisma;
    delete globalScope.guillotinaPrisma;
    process.env.NODE_ENV = 'production';
    const first = createPrismaClient(context.config.databaseUrl);
    const second = createPrismaClient(context.config.databaseUrl);
    expect(second).toBe(first);
    await first.$disconnect();
    delete globalScope.guillotinaPrisma;
    process.env.NODE_ENV = 'test';
    const isolated = createPrismaClient(context.config.databaseUrl);
    expect(globalScope.guillotinaPrisma).toBeUndefined();
    await isolated.$disconnect();
    if (priorGlobal) globalScope.guillotinaPrisma = priorGlobal;
    process.env.NODE_ENV = previous;
  });
});

describe('ramas administrativas de fallo y estados extremos', () => {
  it('devuelve configuración administrativa existente', async () => {
    const editor = await login(context.app, 'editor');
    const response = await context.app.inject({ method: 'GET', url: `${prefix}/admin/settings`, headers: { cookie: editor.cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ brandName: 'La Guillotina' });
  });

  it('maneja configuración ausente y actualización completa', async () => {
    const editor = await login(context.app, 'editor');
    await prisma.siteSettings.delete({ where: { id: 'default' } });
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/admin/settings`, headers: { cookie: editor.cookie } })).statusCode).toBe(503);
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/settings`, headers: authHeaders(editor), payload: { brandName: 'Otra' } })).statusCode).toBe(503);
  });

  it('actualiza todos los opcionales de edición, portada y estados archivados', async () => {
    const editor = await login(context.app, 'editor');
    const response = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${ids.edition}`, headers: authHeaders(editor), payload: {
      title: 'Completa', slug: 'completa', subtitle: 'Sub', date: '2029', status: 'archived', cover: 'https://example.org/nueva.webp', noteIds: [], author: 'Autor', summary: 'Resumen',
    } });
    expect(response.statusCode).toBe(200);
    const edition = await prisma.edition.findUniqueOrThrow({ where: { id: ids.edition }, include: { coverResource: true } });
    expect(edition).toMatchObject({ slug: 'completa', status: 'ARCHIVED', author: 'Autor', summary: 'Resumen' });
    expect(edition.archivedAt).toBeInstanceOf(Date);
    expect(edition.coverResource?.url).toBe('https://example.org/nueva.webp');
  });

  it('cubre primera numeración, slug explícito, edición ausente y portada sin cambiar título/estado', async () => {
    const editor = await login(context.app, 'editor');
    await prisma.note.updateMany({ data: { editionId: null } });
    await prisma.edition.deleteMany();
    const first = await context.app.inject({ method: 'POST', url: `${prefix}/admin/editions`, headers: authHeaders(editor), payload: {
      title: 'Primera revista', slug: 'primera-explicita', date: '2030', noteIds: [],
    } });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ number: '00', slug: 'primera-explicita', subtitle: '' });
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/99999999-9999-4999-8999-999999999999`, headers: authHeaders(editor), payload: { title: 'Ausente' } })).statusCode).toBe(404);
    const cover = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${first.json().id}`, headers: authHeaders(editor), payload: { cover: 'https://example.org/solo-portada.webp' } });
    expect(cover.statusCode).toBe(200);
    const storedCover = await prisma.resource.findFirstOrThrow({ where: { url: 'https://example.org/solo-portada.webp' } });
    expect(storedCover).toMatchObject({ name: 'Portada de Primera revista', status: 'DRAFT' });
    await prisma.edition.update({ where: { id: first.json().id }, data: { number: null } });
    const nullNumber = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/editions/${first.json().id}`, headers: authHeaders(editor), payload: { title: 'Sin número' } });
    expect(nullNumber.json().number).toBe('');
  });

  it('crea notas con defaults y reemplaza recursos con una relación no vacía', async () => {
    const editor = await login(context.app, 'editor');
    const created = await context.app.inject({ method: 'POST', url: `${prefix}/admin/notes`, headers: authHeaders(editor), payload: {
      title: 'Nota mínima válida', excerpt: 'Bajada mínima', body: 'Cuerpo mínimo', categoryIds: [], resourceIds: [],
    } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ author: 'Redacción', editionId: null });
    const updated = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/${created.json().id}`, headers: authHeaders(editor), payload: { resourceIds: [ids.image] } });
    expect(updated.statusCode).toBe(200);
    expect(await prisma.noteResource.count({ where: { noteId: created.json().id, resourceId: ids.image } })).toBe(1);
    const emptyAuthor = await context.app.inject({ method: 'POST', url: `${prefix}/admin/notes`, headers: authHeaders(editor), payload: {
      title: 'Autor por fallback', excerpt: 'Bajada válida', body: 'Cuerpo válido', author: '', categoryIds: [], resourceIds: [],
    } });
    expect(emptyAuthor.statusCode).toBe(201);
    expect(emptyAuthor.json().author).toBe('Redacción');
  });

  it('cubre fechas explícitas y transiciones no destructivas de recursos/categorías', async () => {
    const editor = await login(context.app, 'editor');
    const created = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources`, headers: authHeaders(editor), payload: {
      type: 'link', name: 'Enlace fechado', url: 'https://example.org/fechado', alt: 'Enlace externo', credit: 'Archivo', license: 'CC0', date: '2030-01-02T03:04:05.000Z',
    } });
    expect(created.statusCode).toBe(201);
    const updated = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/resources/${created.json().id}`, headers: authHeaders(editor), payload: { type: 'pdf', status: 'published', date: '2031-02-03T04:05:06.000Z' } });
    expect(updated.statusCode).toBe(200);
    expect(await prisma.resource.findUniqueOrThrow({ where: { id: created.json().id } })).toMatchObject({ type: 'PDF', status: 'PUBLISHED', deletedAt: null });
    const category = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/categories/${ids.category}`, headers: authHeaders(editor), payload: { status: 'review' } });
    expect(category.statusCode).toBe(200);
    expect((await prisma.category.findUniqueOrThrow({ where: { id: ids.category } })).deletedAt).toBeNull();
  });

  it('actualiza contactos sin respuesta y expone fallbacks vacíos/archivo', async () => {
    const moderator = await login(context.app, 'moderator');
    const progress = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/contacts/${ids.contact}`, headers: authHeaders(moderator), payload: { status: 'in_progress' } });
    expect(progress.statusCode).toBe(200);
    expect(progress.json()).toMatchObject({ status: 'in_progress', reply: '', replyStatus: null, sentAt: null });
    const archived = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/contacts/${ids.contact}`, headers: authHeaders(moderator), payload: { status: 'archived' } });
    expect(archived.statusCode).toBe(200);
    expect((await prisma.contactMessage.findUniqueOrThrow({ where: { id: ids.contact } })).archivedAt).toBeInstanceOf(Date);
    const draftOnly = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/contacts/${ids.contact}`, headers: authHeaders(moderator), payload: { reply: 'Sólo borrador', send: false } });
    expect(draftOnly.statusCode).toBe(200);
    expect(draftOnly.json().replyStatus).toBe('draft');
  });

  it('permite degradar otro admin cuando permanece al menos uno activo', async () => {
    const admin = await login(context.app, 'admin');
    const other = await prisma.user.create({ data: { email: 'segundo-admin@laguillotina.local', displayName: 'Segundo admin', role: 'ADMIN' } });
    const response = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/users/${other.id}`, headers: authHeaders(admin), payload: { role: 'reader' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().role).toBe('reader');
    const suspendedAdmin = await prisma.user.create({ data: { email: 'admin-suspendido@laguillotina.local', displayName: 'Admin suspendido', role: 'ADMIN', status: 'SUSPENDED' } });
    const lastAdmin = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/users/${suspendedAdmin.id}`, headers: authHeaders(admin), payload: { role: 'reader' } });
    expect(lastAdmin.statusCode).toBe(409);
    expect(lastAdmin.json().error.code).toBe('LAST_ADMIN');
  });

  it('convierte un rechazo SMTP TCP real en 502 y conserva el reintento', async () => {
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const address = probe.address();
    if (!address || typeof address === 'string') throw new Error('Puerto no disponible');
    const port = address.port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    await context.app.close();
    context = await createTestContext({ mail: { mode: 'smtp', smtpHost: '127.0.0.1', smtpPort: port, smtpUser: 'u', smtpPassword: 'p', smtpFrom: 'test@example.org' } });
    const moderator = await login(context.app, 'moderator');
    const response = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/contacts/${ids.contact}`, headers: authHeaders(moderator), payload: { status: 'answered', reply: 'Falla de red.' } });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('MAIL_DELIVERY_FAILED');
    expect((await prisma.contactReply.findFirstOrThrow({ where: { contactId: ids.contact } })).status).toBe('FAILED');
  });

  it('serializa dashboard con número nulo, actor sistema y rol reader interno', async () => {
    await prisma.edition.update({ where: { id: ids.edition }, data: { number: null } });
    await prisma.adminLog.create({ data: { action: 'Tarea automática', entityType: 'system', actorId: null } });
    const dashboard = await getDashboard(prisma, { page: 1, pageSize: 10, section: 'all', role: 'ADMIN', from: new Date(0) });
    expect(dashboard.editions.find(item => item.id === ids.edition)?.number).toBe('');
    expect(dashboard.logs.find(item => item.action === 'Tarea automática')?.actor).toBe('Sistema');
    const readerDashboard = await getDashboard(prisma, { page: 1, pageSize: 10, section: 'all', role: 'READER', from: new Date(0) });
    expect(readerDashboard.editions).toEqual([]);
    expect(readerDashboard.contacts).toEqual([]);
  });

  it('devuelve 404 para nota/contacto inexistentes y conserva el último admin', async () => {
    const editor = await login(context.app, 'editor');
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/notes/99999999-9999-4999-8999-999999999999`, headers: authHeaders(editor), payload: { title: 'Ausente' } })).statusCode).toBe(404);
    const moderator = await login(context.app, 'moderator');
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/contacts/99999999-9999-4999-8999-999999999999`, headers: authHeaders(moderator), payload: { status: 'archived' } })).statusCode).toBe(404);
    const admin = await login(context.app, 'admin');
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/users/${ids.admin}`, headers: authHeaders(admin), payload: { status: 'suspended' } })).statusCode).toBe(409);
  });

  it('registra como failed un SMTP no configurado al responder un contacto', async () => {
    await context.app.close();
    context = await createTestContext({ mail: { mode: 'smtp', smtpHost: undefined, smtpUser: undefined, smtpPassword: undefined, smtpFrom: undefined } });
    const moderator = await login(context.app, 'moderator');
    const response = await context.app.inject({ method: 'PATCH', url: `${prefix}/admin/contacts/${ids.contact}`, headers: authHeaders(moderator), payload: { status: 'answered', reply: 'Intento fallido.' } });
    expect(response.statusCode).toBe(503);
    const reply = await prisma.contactReply.findFirstOrThrow({ where: { contactId: ids.contact } });
    expect(reply.status).toBe('FAILED');
    expect(reply.error).toContain('correo');
  });
});

describe('bordes de autenticación, comunidad y analítica', () => {
  it('acepta las tres variantes de avatar y rechaza password en cuenta sin hash', async () => {
    const reader = await login(context.app, 'reader');
    for (const avatarUrl of ['', 'data:image/png;base64,AA==', 'https://example.org/avatar.png']) {
      const response = await context.app.inject({ method: 'PATCH', url: `${prefix}/auth/profile`, headers: authHeaders(reader), payload: { avatarUrl } });
      expect(response.statusCode).toBe(200);
    }
    await prisma.user.update({ where: { id: ids.reader }, data: { passwordHash: null } });
    const password = await context.app.inject({ method: 'PATCH', url: `${prefix}/auth/profile`, headers: authHeaders(reader), payload: { currentPassword: 'guillotina', newPassword: 'otra-clave-segura' } });
    expect(password.statusCode).toBe(400);
    expect(password.json().error.code).toBe('CURRENT_PASSWORD_INVALID');
  });

  it('persiste preferencias con y sin vencimiento', async () => {
    const reader = await login(context.app, 'reader');
    const expiresAt = Date.now() + 86_400_000;
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/auth/preferences`, headers: authHeaders(reader), payload: { theme: 'light', expiresAt } })).statusCode).toBe(200);
    expect((await prisma.userPreference.findUniqueOrThrow({ where: { userId: ids.reader } })).expiresAt).toBeInstanceOf(Date);
    expect((await context.app.inject({ method: 'PATCH', url: `${prefix}/auth/preferences`, headers: authHeaders(reader), payload: { theme: 'dark' } })).statusCode).toBe(200);
  });

  it('distingue cada nivel de configuración OAuth y el estado preparado', async () => {
    await context.app.close();
    context = await createTestContext({ oauth: { google: { clientId: 'id', clientSecret: undefined, callbackUrl: undefined } } });
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/auth/oauth/google` })).json().error.code).toBe('OAUTH_NOT_CONFIGURED');
    await context.app.close();
    context = await createTestContext({ oauth: { google: { clientId: 'id', clientSecret: 'secret', callbackUrl: undefined } } });
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/auth/oauth/google` })).json().error.code).toBe('OAUTH_NOT_CONFIGURED');
    await context.app.close();
    context = await createTestContext({ oauth: { google: { clientId: 'id', clientSecret: 'secret', callbackUrl: 'https://example.org/callback' } } });
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/auth/oauth/google` })).json().error.code).toBe('OAUTH_PENDING');
  });

  it('cubre contenido inexistente, edición sin número/portada y rating serializado', async () => {
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/notes/no-existe/comments` })).statusCode).toBe(404);
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/notes/${ids.draftNote}/comments` })).statusCode).toBe(404);
    expect((await context.app.inject({ method: 'POST', url: `${prefix}/notes/no-existe/comments/${ids.comment}/upvote` })).statusCode).toBe(404);
    expect((await context.app.inject({ method: 'POST', url: `${prefix}/notes/no-existe/rating`, payload: { score: 3 } })).statusCode).toBe(404);
    await prisma.edition.update({ where: { id: ids.book }, data: { number: null, coverResourceId: null } });
    const book = await context.app.inject({ method: 'GET', url: `${prefix}/editions/libro-de-prueba/home` });
    expect(book.json()).toMatchObject({ edition: { number: null }, masthead: { image: '', alt: '' } });
    await prisma.noteRating.createMany({ data: [
      { noteId: ids.note, voterKey: 'coverage-rating-1', score: 2 }, { noteId: ids.note, voterKey: 'coverage-rating-2', score: 4 },
    ] });
    const note = await context.app.inject({ method: 'GET', url: `${prefix}/notes/freedom` });
    expect(note.json()).toMatchObject({ rating: 3, ratingsCount: 2 });
  });

  it('cubre filtros alternativos, recursos ligados a edición y comentario anónimo total', async () => {
    await prisma.editionResource.create({ data: { editionId: ids.edition, resourceId: ids.image, role: 'cover' } });
    for (const query of [
      'section=showcase', 'section=showcase&type=image', 'section=showcase&type=video',
      'section=showcase&tag=autogestion', 'section=multimedia&type=video', 'section=magazines&search=libertad',
    ]) {
      const response = await context.app.inject({ method: 'GET', url: `${prefix}/catalog?${query}` });
      expect(response.statusCode).toBe(200);
    }
    const catalog = await context.app.inject({ method: 'GET', url: `${prefix}/catalog?section=showcase&type=image` });
    const linkedImage = catalog.json().showcase.find((item: { id: string }) => item.id === ids.image);
    expect(linkedImage.editions).toEqual([expect.objectContaining({ slug: 'n-012-la-libertad' })]);
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/resources` })).statusCode).toBe(200);
    expect((await context.app.inject({ method: 'GET', url: `${prefix}/resources?types=image` })).statusCode).toBe(200);
    const anonymous = await context.app.inject({ method: 'POST', url: `${prefix}/notes/${ids.note}/comments`, payload: { body: 'Comentario sin nombre.' } });
    expect(anonymous.statusCode).toBe(201);
    expect(anonymous.json().author).toBe('Anónima');
    const missingReport = await context.app.inject({ method: 'POST', url: `${prefix}/notes/no-existe/comments/${ids.comment}/report`, payload: { reason: 'spam' } });
    expect(missingReport.statusCode).toBe(404);
  });

  it('clasifica social/referral y admite eventos sin relaciones ni fecha explícita', async () => {
    const response = await context.app.inject({ method: 'POST', url: `${prefix}/analytics/events`, payload: {
      sessionId: 'coverage-session-123456', events: [
        { type: 'referral', source: 'https://instagram.com/post' },
        { type: 'page_view', source: 'https://sitio-independiente.example', occurredAt: '2025-01-01T00:00:00.000Z' },
      ],
    } });
    expect(response.statusCode).toBe(202);
    expect((await prisma.analyticsEvent.findMany({ where: { sessionHash: { not: null } }, orderBy: { occurredAt: 'asc' } })).map(item => item.sourceCategory)).toEqual(['referral', 'social']);
  });

  it('propaga fallos PostgreSQL no duplicados en votos y reportes', async () => {
    await prisma.$executeRawUnsafe('ALTER TABLE comment_votes RENAME TO comment_votes_unavailable');
    try {
      const vote = await context.app.inject({ method: 'POST', url: `${prefix}/notes/${ids.note}/comments/${ids.comment}/upvote` });
      expect(vote.statusCode).toBe(500);
    } finally { await prisma.$executeRawUnsafe('ALTER TABLE comment_votes_unavailable RENAME TO comment_votes'); }
    await prisma.$executeRawUnsafe('ALTER TABLE comment_reports RENAME TO comment_reports_unavailable');
    try {
      const report = await context.app.inject({ method: 'POST', url: `${prefix}/notes/${ids.note}/comments/${ids.comment}/report`, payload: { reason: 'spam' } });
      expect(report.statusCode).toBe(500);
    } finally { await prisma.$executeRawUnsafe('ALTER TABLE comment_reports_unavailable RENAME TO comment_reports'); }
  });
});

async function startSmtpServer(received: string[]): Promise<Server> {
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    socket.write('220 localhost ESMTP test\r\n');
    let buffer = '';
    let dataMode = false;
    socket.on('data', chunk => {
      buffer += chunk;
      while (true) {
        if (dataMode) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) break;
          received.push(buffer.slice(0, end));
          buffer = buffer.slice(end + 5);
          dataMode = false;
          socket.write('250 2.0.0 queued\r\n');
          continue;
        }
        const end = buffer.indexOf('\r\n');
        if (end < 0) break;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (/^(EHLO|HELO)/i.test(line)) socket.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (/^AUTH/i.test(line)) socket.write('235 2.7.0 authenticated\r\n');
        else if (/^(MAIL FROM|RCPT TO)/i.test(line)) { received.push(line); socket.write('250 2.1.0 ok\r\n'); }
        else if (/^DATA/i.test(line)) { dataMode = true; socket.write('354 end with <CRLF>.<CRLF>\r\n'); }
        else if (/^QUIT/i.test(line)) { socket.write('221 bye\r\n'); socket.end(); }
        else socket.write('250 ok\r\n');
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()); });
  return server;
}
