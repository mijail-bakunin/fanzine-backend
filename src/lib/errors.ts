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
  return new AppError(500, 'INTERNAL_ERROR', 'Ocurrió un error interno inesperado.');
}
