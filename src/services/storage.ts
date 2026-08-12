import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../lib/errors.js';

export type CompletedPart = { partNumber: number; etag: string };

export class StorageService {
  private readonly client: S3Client | null;

  constructor(private readonly config: AppConfig) {
    if (config.storageDriver === 's3') {
      const { endpoint, region, bucket, accessKeyId, secretAccessKey } = config.s3;
      if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
        throw new AppError(500, 'STORAGE_NOT_CONFIGURED', 'Faltan variables del almacenamiento S3-compatible.');
      }
      this.client = new S3Client({
        endpoint,
        region,
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
      });
    } else {
      this.client = null;
    }
  }

  get driver() {
    return this.config.storageDriver;
  }

  publicUrl(objectKey: string) {
    if (this.config.storageDriver === 'local') return `${this.config.publicStorageBaseUrl}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
    const base = this.config.s3.publicBaseUrl;
    if (!base) throw new AppError(500, 'STORAGE_PUBLIC_URL_MISSING', 'Falta S3_PUBLIC_BASE_URL.');
    return `${base}/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
  }

  async saveLocal(objectKey: string, stream: Readable) {
    if (this.config.storageDriver !== 'local') throw new AppError(409, 'DIRECT_UPLOAD_REQUIRED', 'Usá la carga directa firmada para este almacenamiento.');
    const root = path.resolve(this.config.localStoragePath);
    const destination = path.resolve(root, objectKey);
    if (!destination.startsWith(`${root}${path.sep}`)) throw new AppError(400, 'INVALID_OBJECT_KEY', 'La ruta del archivo no es válida.');
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await pipeline(stream, createWriteStream(destination, { flags: 'wx' }));
    } catch (error) {
      await rm(destination, { force: true });
      throw error;
    }
    return this.publicUrl(objectKey);
  }

  async deleteLocal(objectKey: string) {
    if (this.config.storageDriver !== 'local') return;
    const root = path.resolve(this.config.localStoragePath);
    const destination = path.resolve(root, objectKey);
    if (!destination.startsWith(`${root}${path.sep}`)) return;
    await rm(destination, { force: true });
  }

  async signPut(objectKey: string, mimeType: string) {
    const client = this.requireS3();
    const command = new PutObjectCommand({ Bucket: this.config.s3.bucket!, Key: objectKey, ContentType: mimeType });
    const uploadUrl = await getSignedUrl(client, command, { expiresIn: this.config.signedUploadTtlSeconds });
    return { uploadUrl, method: 'PUT' as const, headers: { 'Content-Type': mimeType } };
  }

  async createMultipart(objectKey: string, mimeType: string) {
    const response = await this.requireS3().send(new CreateMultipartUploadCommand({
      Bucket: this.config.s3.bucket!, Key: objectKey, ContentType: mimeType,
    }));
    if (!response.UploadId) throw new AppError(502, 'STORAGE_UPLOAD_FAILED', 'El almacenamiento no inició la carga multipart.');
    return response.UploadId;
  }

  async signPart(objectKey: string, uploadId: string, partNumber: number) {
    const command = new UploadPartCommand({ Bucket: this.config.s3.bucket!, Key: objectKey, UploadId: uploadId, PartNumber: partNumber });
    return getSignedUrl(this.requireS3(), command, { expiresIn: this.config.signedUploadTtlSeconds });
  }

  async completeMultipart(objectKey: string, uploadId: string, parts: CompletedPart[]) {
    await this.requireS3().send(new CompleteMultipartUploadCommand({
      Bucket: this.config.s3.bucket!,
      Key: objectKey,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts.map(part => ({ ETag: part.etag, PartNumber: part.partNumber })) },
    }));
    return this.publicUrl(objectKey);
  }

  async abortMultipart(objectKey: string, uploadId: string) {
    await this.requireS3().send(new AbortMultipartUploadCommand({
      Bucket: this.config.s3.bucket!, Key: objectKey, UploadId: uploadId,
    }));
  }

  async head(objectKey: string) {
    const result = await this.requireS3().send(new HeadObjectCommand({ Bucket: this.config.s3.bucket!, Key: objectKey }));
    return { size: Number(result.ContentLength ?? 0), mimeType: result.ContentType ?? null, etag: result.ETag ?? null };
  }

  private requireS3() {
    if (!this.client) throw new AppError(409, 'S3_STORAGE_REQUIRED', 'Esta operación requiere almacenamiento S3-compatible.');
    return this.client;
  }
}

export function objectKeyFor(fileName: string) {
  const extension = path.extname(fileName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12);
  const date = new Date();
  const prefix = `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  return `${prefix}/${crypto.randomUUID()}${extension}`;
}
