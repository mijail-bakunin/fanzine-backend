import { Prisma } from '../generated/prisma/client.js';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function notFound(message = 'No encontramos el recurso solicitado.') {
  return new AppError(404, 'NOT_FOUND', message);
}

export function conflict(message: string, details?: unknown) {
  return new AppError(409, 'CONFLICT', message, details);
}

export function toHttpError(error: unknown) {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError) {
    return new AppError(400, 'VALIDATION_ERROR', 'El pedido contiene datos inválidos.', error.flatten());
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return conflict('Ya existe un registro con esos datos.', error.meta);
    if (error.code === 'P2025') return notFound();
    if (error.code === 'P2003') return new AppError(409, 'RELATION_CONFLICT', 'El recurso está vinculado y no puede modificarse de esa manera.');
  }
  if (isHttpError(error)) {
    if (error.statusCode === 429) {
      return new AppError(429, 'RATE_LIMIT_EXCEEDED', 'Superaste temporalmente el límite de solicitudes. Intentá de nuevo más tarde.');
    }
    if (error.statusCode === 413) {
      return new AppError(413, 'PAYLOAD_TOO_LARGE', 'El contenido enviado supera el tamaño permitido.');
    }
    const code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(error.code)
      ? error.code
      : `HTTP_${error.statusCode}`;
    const message = error.statusCode >= 500
      ? 'Ocurrió un error interno inesperado.'
      : typeof error.message === 'string' && error.message.length > 0
        ? error.message
        : 'No fue posible procesar el pedido.';
    return new AppError(error.statusCode, code, message);
  }
  if (error instanceof Error && error.message === 'Origen no permitido por CORS.') {
    return new AppError(403, 'CORS_ORIGIN_DENIED', error.message);
  }
  return new AppError(500, 'INTERNAL_ERROR', 'Ocurrió un error interno inesperado.');
}

function isHttpError(error: unknown): error is { statusCode: number; code?: unknown; message?: unknown } {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return false;
  const statusCode = Number(error.statusCode);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599;
}
