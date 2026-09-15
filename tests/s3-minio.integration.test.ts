import {
  DeleteObjectsCommand, HeadBucketCommand, ListObjectsV2Command, S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  authHeaders, closeTestDatabase, createTestContext, login, prefix, prisma, type TestContext,
} from './helpers/test-context.js';

const endpoint = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9000';
const bucket = process.env.TEST_S3_BUCKET ?? 'laguillotina-test';
const accessKeyId = process.env.TEST_S3_ACCESS_KEY_ID ?? 'guillotina_test';
const secretAccessKey = process.env.TEST_S3_SECRET_ACCESS_KEY ?? 'guillotina_test_secret';
const publicBaseUrl = process.env.TEST_S3_PUBLIC_BASE_URL ?? `${endpoint}/${bucket}`;

const client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
let context: TestContext;

beforeEach(async () => {
  context = await createS3Context(1);
  await clearBucket();
});
afterEach(async () => { await context.app.close(); });
afterAll(async () => { client.destroy(); await closeTestDatabase(); });

describe('S3/R2 empírico contra MinIO', () => {
  it('se conecta al bucket real configurado', async () => {
    const result = await client.send(new HeadBucketCommand({ Bucket: bucket }));
    expect(result.$metadata.httpStatusCode).toBe(200);
  });

  it('realiza carga single mediante URL firmada y verifica bytes/tamaño al completar', async () => {
    await context.app.close();
    context = await createS3Context(1_000_000);
    const admin = await login(context.app, 'admin');
    const bytes = Buffer.from('contenido empírico de un PDF');
    const started = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads`, headers: authHeaders(admin), payload: {
      type: 'pdf', name: 'PDF firmado', alt: 'Documento de prueba', credit: 'Suite', license: 'CC0', status: 'published',
      fileName: 'documento.pdf', fileSize: bytes.length, mimeType: 'application/pdf',
    } });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({ mode: 'single', method: 'PUT', headers: { 'Content-Type': 'application/pdf' } });
    const put = await fetch(started.json().uploadUrl, { method: 'PUT', headers: started.json().headers, body: bytes });
    expect(put.status).toBe(200);
    const completed = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads/${started.json().uploadId}/complete`, headers: authHeaders(admin), payload: { parts: [] } });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ id: started.json().resourceId, uploadStatus: 'complete', storageDriver: 's3', fileSize: bytes.length, mimeType: 'application/pdf' });
    const download = await fetch(completed.json().url);
    expect(download.status).toBe(200);
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
    const stored = await prisma.resource.findUniqueOrThrow({ where: { id: started.json().resourceId } });
    expect(stored.checksum).toBeTruthy();
  });

  it('sube dos partes reales, completa multipart y publica el archivo íntegro', async () => {
    const editor = await login(context.app, 'editor');
    const partOne = Buffer.alloc(5 * 1024 * 1024, 0x61);
    const partTwo = Buffer.from('parte-final');
    const totalSize = partOne.length + partTwo.length;
    const started = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads`, headers: authHeaders(editor), payload: {
      type: 'video', name: 'Video multipart real', alt: 'Video dividido', credit: 'Suite', license: 'CC0', status: 'draft',
      fileName: 'video.mp4', fileSize: totalSize, mimeType: 'video/mp4',
    } });
    expect(started.statusCode).toBe(201);
    expect(started.json().mode).toBe('multipart');
    expect(started.json().partSize).toBeGreaterThanOrEqual(5 * 1024 * 1024);

    const uploadedParts = [];
    for (const [index, bytes] of [partOne, partTwo].entries()) {
      const signed = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads/${started.json().uploadId}/part`, headers: authHeaders(editor), payload: { partNumber: index + 1 } });
      expect(signed.statusCode).toBe(200);
      const put = await fetch(signed.json().uploadUrl, { method: 'PUT', body: bytes });
      expect(put.status).toBe(200);
      const etag = put.headers.get('etag');
      expect(etag).toBeTruthy();
      uploadedParts.push({ partNumber: index + 1, etag });
    }
    const completed = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads/${started.json().uploadId}/complete`, headers: authHeaders(editor), payload: { parts: uploadedParts } });
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({ id: started.json().resourceId, uploadStatus: 'complete', fileSize: totalSize });
    const download = await fetch(completed.json().url);
    const downloaded = Buffer.from(await download.arrayBuffer());
    expect(download.status).toBe(200);
    expect(downloaded.length).toBe(totalSize);
    expect(downloaded.subarray(0, 32)).toEqual(partOne.subarray(0, 32));
    expect(downloaded.subarray(-partTwo.length)).toEqual(partTwo);
  }, 60_000);

  it('detecta diferencias de tamaño y no marca la carga como completa', async () => {
    await context.app.close();
    context = await createS3Context(1_000_000);
    const admin = await login(context.app, 'admin');
    const started = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads`, headers: authHeaders(admin), payload: {
      type: 'audio', name: 'Audio truncado', alt: 'Tamaño incorrecto', credit: 'Suite', license: 'CC0', status: 'draft', fileName: 'audio.mp3', fileSize: 20, mimeType: 'audio/mpeg',
    } });
    expect(started.statusCode).toBe(201);
    expect((await fetch(started.json().uploadUrl, { method: 'PUT', headers: started.json().headers, body: Buffer.alloc(10, 1) })).status).toBe(200);
    const completed = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads/${started.json().uploadId}/complete`, headers: authHeaders(admin), payload: { parts: [] } });
    expect(completed.statusCode).toBe(409);
    expect(completed.json().error.code).toBe('UPLOAD_SIZE_MISMATCH');
    const resource = await prisma.resource.findUniqueOrThrow({ where: { id: started.json().resourceId } });
    const upload = await prisma.resourceUpload.findUniqueOrThrow({ where: { id: started.json().uploadId } });
    expect(resource.uploadStatus).toBe('UPLOADING');
    expect(upload.status).toBe('UPLOADING');
  });

  it('cancela multipart en MinIO y aplica borrado lógico al recurso', async () => {
    const admin = await login(context.app, 'admin');
    const started = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads`, headers: authHeaders(admin), payload: {
      type: 'video', name: 'Carga cancelada', alt: 'No debe completarse', credit: 'Suite', license: 'CC0', status: 'draft', fileName: 'cancelado.mp4', fileSize: 100, mimeType: 'video/mp4',
    } });
    expect(started.json().mode).toBe('multipart');
    const aborted = await context.app.inject({ method: 'DELETE', url: `${prefix}/admin/resources/uploads/${started.json().uploadId}`, headers: authHeaders(admin) });
    expect(aborted.statusCode).toBe(204);
    const resource = await prisma.resource.findUniqueOrThrow({ where: { id: started.json().resourceId } });
    const upload = await prisma.resourceUpload.findUniqueOrThrow({ where: { id: started.json().uploadId } });
    expect(resource).toMatchObject({ uploadStatus: 'ABORTED', status: 'DELETED' });
    expect(resource.deletedAt).toBeInstanceOf(Date);
    expect(upload.status).toBe('ABORTED');
  });

  it('rechaza sesiones vencidas y números de parte inválidos sin hablar con éxito al storage', async () => {
    const admin = await login(context.app, 'admin');
    const started = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads`, headers: authHeaders(admin), payload: {
      type: 'video', name: 'Carga vencida', alt: 'Debe vencer', credit: 'Suite', license: 'CC0', status: 'draft', fileName: 'vencido.mp4', fileSize: 100, mimeType: 'video/mp4',
    } });
    const invalidPart = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads/${started.json().uploadId}/part`, headers: authHeaders(admin), payload: { partNumber: 0 } });
    expect(invalidPart.statusCode).toBe(400);
    await prisma.resourceUpload.update({ where: { id: started.json().uploadId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    const expired = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads/${started.json().uploadId}/part`, headers: authHeaders(admin), payload: { partNumber: 1 } });
    expect(expired.statusCode).toBe(410);
    expect(expired.json().error.code).toBe('UPLOAD_EXPIRED');
  }, 120_000);

  it('distingue rutas local/S3, single/multipart y permite cancelar single', async () => {
    await context.app.close();
    context = await createS3Context(1_000_000);
    const admin = await login(context.app, 'admin');
    const localRoute = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/upload`, headers: authHeaders(admin) });
    expect(localRoute.statusCode).toBe(409);
    const started = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads`, headers: authHeaders(admin), payload: {
      type: 'image', name: 'Single cancelable', alt: 'Carga single', credit: 'Suite', license: 'CC0', status: 'draft',
      fileName: 'single.png', fileSize: 10, mimeType: 'image/png', date: '2030-01-02T03:04:05.000Z',
    } });
    expect(started.json().mode).toBe('single');
    const part = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads/${started.json().uploadId}/part`, headers: authHeaders(admin), payload: { partNumber: 1 } });
    expect(part.statusCode).toBe(409);
    expect(part.json().error.code).toBe('NOT_MULTIPART_UPLOAD');
    const aborted = await context.app.inject({ method: 'DELETE', url: `${prefix}/admin/resources/uploads/${started.json().uploadId}`, headers: authHeaders(admin) });
    expect(aborted.statusCode).toBe(204);
    expect((await prisma.resourceUpload.findUniqueOrThrow({ where: { id: started.json().uploadId } })).status).toBe('ABORTED');
  });

  it('exige partes multipart y rechaza cargas inexistentes o ya finalizadas', async () => {
    const admin = await login(context.app, 'admin');
    const multipart = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads`, headers: authHeaders(admin), payload: {
      type: 'video', name: 'Sin partes', alt: 'Multipart incompleto', credit: 'Suite', license: 'CC0', status: 'draft', fileName: 'sin-partes.mp4', fileSize: 100, mimeType: 'video/mp4',
    } });
    const noParts = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads/${multipart.json().uploadId}/complete`, headers: authHeaders(admin), payload: {} });
    expect(noParts.statusCode).toBe(400);
    expect(noParts.json().error.code).toBe('PARTS_REQUIRED');
    const absent = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads/99999999-9999-4999-8999-999999999999/part`, headers: authHeaders(admin), payload: { partNumber: 1 } });
    expect(absent.statusCode).toBe(404);

    await context.app.close();
    context = await createS3Context(1_000_000);
    const auth = await login(context.app, 'admin');
    const bytes = Buffer.from('final sin body JSON');
    const single = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads`, headers: authHeaders(auth), payload: {
      type: 'pdf', name: 'Finalizado', alt: 'Finalizado', credit: 'Suite', license: 'CC0', status: 'published', fileName: 'final.pdf', fileSize: bytes.length, mimeType: 'application/pdf',
    } });
    expect((await fetch(single.json().uploadUrl, { method: 'PUT', headers: single.json().headers, body: bytes })).status).toBe(200);
    const completed = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads/${single.json().uploadId}/complete`, headers: authHeaders(auth) });
    expect(completed.statusCode).toBe(200);
    const alreadyComplete = await context.app.inject({ method: 'POST', url: `${prefix}/admin/resources/uploads/${single.json().uploadId}/part`, headers: authHeaders(auth), payload: { partNumber: 1 } });
    expect(alreadyComplete.statusCode).toBe(404);
  });
});

async function createS3Context(multipartThresholdBytes: number) {
  return createTestContext({
    storageDriver: 's3', multipartThresholdBytes, signedUploadTtlSeconds: 300,
    s3: { endpoint, region: 'us-east-1', bucket, accessKeyId, secretAccessKey, publicBaseUrl },
  });
}

async function clearBucket() {
  const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
  const objects = (listed.Contents ?? []).flatMap(item => item.Key ? [{ Key: item.Key }] : []);
  if (objects.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }));
}
