import { Transform } from 'node:stream';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { parse } from '../../lib/validation.js';
import { requireCsrf, requireRole } from '../auth/auth-context.js';
import { audit } from '../admin/audit.js';
import { resourceMetadataSchema } from '../admin/admin.routes.js';
import { serializeResource } from '../content/serializers.js';
import { objectKeyFor, StorageService } from '../../services/storage.js';

export const resourceRoutes: FastifyPluginAsync = async app => {
  const storage = new StorageService(app.config);
  app.addHook('preHandler', async request => {
    requireRole(request, ['ADMIN', 'EDITOR']);
    requireCsrf(request);
  });

  app.post('/admin/resources/upload', async (request, reply) => {
    if (storage.driver !== 'local') throw new AppError(409, 'DIRECT_UPLOAD_REQUIRED', 'En producción usá el flujo de carga directa firmada.');
    const data = await request.file({ limits: { fileSize: app.config.maxVideoBytes, files: 1, fields: 20 } });
    if (!data) throw new AppError(400, 'FILE_REQUIRED', 'Seleccioná un archivo para subir.');
    const objectKey = objectKeyFor(data.filename);
    let bytes = 0;
    const counter = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; callback(null, chunk); } });
    try {
      const url = await storage.saveLocal(objectKey, data.file.pipe(counter));
      if (data.file.truncated) throw new AppError(413, 'FILE_TOO_LARGE', 'El archivo supera el límite permitido.');
      const fields = Object.fromEntries(Object.entries(data.fields).map(([key, value]) => [key, fieldValue(value)]));
      const input = parse(resourceMetadataSchema.extend({
        type: z.enum(['image', 'video', 'pdf', 'audio']),
        fileSize: z.number().optional(),
      }), { ...fields, fileSize: bytes, fileName: data.filename, mimeType: data.mimetype });
      validateFile(input.type, data.mimetype, bytes, app.config.maxVideoBytes, app.config.maxDefaultFileBytes);
      const resource = await app.prisma.resource.create({ data: {
        type: input.type.toUpperCase() as never, storageDriver: 'LOCAL', name: input.name, url, objectKey,
        fileName: data.filename, fileSize: bytes, mimeType: data.mimetype, alt: input.alt, credit: input.credit,
        license: input.license, status: input.status.toUpperCase() as never, uploadStatus: 'COMPLETE',
        resourceDate: input.date ? new Date(input.date) : new Date(), createdById: request.auth!.user.id,
      } });
      await audit(request, { action: `Subió el recurso “${resource.name}”.`, entityType: 'resource', entityId: resource.id, metadata: { bytes, mimeType: data.mimetype } });
      return reply.code(201).send(serializeResource(resource));
    } catch (error) {
      await storage.deleteLocal(objectKey);
      throw error;
    }
  });

  app.post('/admin/resources/uploads', async (request, reply) => {
    if (storage.driver !== 's3') throw new AppError(409, 'LOCAL_UPLOAD_REQUIRED', 'En desarrollo local usá /admin/resources/upload.');
    const input = parse(resourceMetadataSchema.extend({
      type: z.enum(['image', 'video', 'pdf', 'audio']),
      fileName: z.string().trim().min(1).max(255),
      fileSize: z.number().int().positive(),
      mimeType: z.string().trim().min(3).max(160),
    }), request.body);
    validateFile(input.type, input.mimeType, input.fileSize, app.config.maxVideoBytes, app.config.maxDefaultFileBytes);
    const objectKey = objectKeyFor(input.fileName);
    const resource = await app.prisma.resource.create({ data: {
      type: input.type.toUpperCase() as never, storageDriver: 'S3', name: input.name, url: '', objectKey,
      fileName: input.fileName, fileSize: input.fileSize, mimeType: input.mimeType, alt: input.alt, credit: input.credit,
      license: input.license, status: input.status.toUpperCase() as never, uploadStatus: 'UPLOADING',
      resourceDate: input.date ? new Date(input.date) : new Date(), createdById: request.auth!.user.id,
    } });
    const multipart = input.fileSize >= app.config.multipartThresholdBytes;
    const providerId = multipart ? await storage.createMultipart(objectKey, input.mimeType) : null;
    const upload = await app.prisma.resourceUpload.create({ data: {
      resourceId: resource.id, createdById: request.auth!.user.id, providerId, objectKey,
      status: 'UPLOADING', fileName: input.fileName, fileSize: input.fileSize, mimeType: input.mimeType,
      expiresAt: new Date(Date.now() + app.config.signedUploadTtlSeconds * 1_000),
    } });
    if (multipart) {
      const partSize = Math.max(5 * 1024 * 1024, Math.ceil(input.fileSize / 10_000), 25 * 1024 * 1024);
      return reply.code(201).send({ mode: 'multipart', uploadId: upload.id, resourceId: resource.id, partSize, expiresAt: upload.expiresAt.toISOString() });
    }
    const signed = await storage.signPut(objectKey, input.mimeType);
    return reply.code(201).send({ mode: 'single', uploadId: upload.id, resourceId: resource.id, ...signed, expiresAt: upload.expiresAt.toISOString() });
  });

  app.post('/admin/resources/uploads/:id/part', async request => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const { partNumber } = parse(z.object({ partNumber: z.number().int().min(1).max(10_000) }), request.body);
    const upload = await activeUpload(app, id);
    if (!upload.providerId) throw new AppError(409, 'NOT_MULTIPART_UPLOAD', 'Esta carga no usa partes.');
    const uploadUrl = await storage.signPart(upload.objectKey, upload.providerId, partNumber);
    return { partNumber, uploadUrl, method: 'PUT', expiresAt: new Date(Date.now() + app.config.signedUploadTtlSeconds * 1_000).toISOString() };
  });

  app.post('/admin/resources/uploads/:id/complete', async request => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const input = parse(z.object({ parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(200) })).max(10_000).default([]) }), request.body ?? {});
    const upload = await activeUpload(app, id);
    if (upload.providerId) {
      if (!input.parts.length) throw new AppError(400, 'PARTS_REQUIRED', 'Faltan las partes completadas.');
      await storage.completeMultipart(upload.objectKey, upload.providerId, input.parts);
    }
    const head = await storage.head(upload.objectKey);
    if (head.size !== upload.fileSize) throw new AppError(409, 'UPLOAD_SIZE_MISMATCH', 'El tamaño almacenado no coincide con el archivo declarado.');
    const url = storage.publicUrl(upload.objectKey);
    const resource = await app.prisma.$transaction(async tx => {
      await tx.resourceUpload.update({ where: { id }, data: { status: 'COMPLETE', completedAt: new Date(), parts: input.parts } });
      return tx.resource.update({ where: { id: upload.resourceId }, data: { url, uploadStatus: 'COMPLETE', checksum: head.etag } });
    });
    await audit(request, { action: `Completó la carga de “${resource.name}”.`, entityType: 'resource', entityId: resource.id });
    return serializeResource(resource);
  });

  app.delete('/admin/resources/uploads/:id', async (request, reply) => {
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params);
    const upload = await activeUpload(app, id);
    if (upload.providerId) await storage.abortMultipart(upload.objectKey, upload.providerId);
    await app.prisma.$transaction([
      app.prisma.resourceUpload.update({ where: { id }, data: { status: 'ABORTED' } }),
      app.prisma.resource.update({ where: { id: upload.resourceId }, data: { uploadStatus: 'ABORTED', status: 'DELETED', deletedAt: new Date() } }),
    ]);
    await audit(request, { action: 'Abortó una carga de recurso.', entityType: 'resource', entityId: upload.resourceId });
    return reply.code(204).send();
  });
};

function fieldValue(value: unknown) {
  if (Array.isArray(value)) return fieldValue(value.at(-1));
  if (value && typeof value === 'object' && 'value' in value) return String((value as { value: unknown }).value ?? '');
  return String(value ?? '');
}

function validateFile(type: 'image' | 'video' | 'pdf' | 'audio', mimeType: string, size: number, maxVideo: number, maxDefault: number) {
  const valid = type === 'image' ? mimeType.startsWith('image/')
    : type === 'video' ? mimeType.startsWith('video/')
      : type === 'audio' ? mimeType.startsWith('audio/')
        : mimeType === 'application/pdf';
  if (!valid) throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'El tipo declarado no coincide con el archivo.');
  const limit = type === 'video' ? maxVideo : maxDefault;
  if (size > limit) throw new AppError(413, 'FILE_TOO_LARGE', `El archivo supera el límite de ${Math.round(limit / 1024 / 1024)} MB.`);
}

async function activeUpload(app: Parameters<FastifyPluginAsync>[0], id: string) {
  const upload = await app.prisma.resourceUpload.findUnique({ where: { id }, include: { resource: true } });
  if (!upload || !['PENDING', 'UPLOADING'].includes(upload.status)) throw new AppError(404, 'UPLOAD_NOT_FOUND', 'No encontramos una carga activa.');
  if (upload.expiresAt <= new Date()) throw new AppError(410, 'UPLOAD_EXPIRED', 'La sesión de carga venció.');
  return upload;
}
