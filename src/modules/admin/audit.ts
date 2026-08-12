import type { FastifyRequest } from 'fastify';
import type { LogLevel } from '../../generated/prisma/client.js';

export async function audit(request: FastifyRequest, input: {
  action: string;
  level?: LogLevel;
  entityType?: string;
  entityId?: string;
  metadata?: Record<string, string | number | boolean | null>;
}) {
  await request.server.prisma.adminLog.create({
    data: {
      actorId: request.auth?.user.id,
      action: input.action,
      level: input.level ?? 'INFO',
      entityType: input.entityType,
      entityId: input.entityId,
      requestId: request.id,
      metadata: input.metadata,
    },
  });
}
