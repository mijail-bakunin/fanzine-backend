import type { PrismaClient } from '../../generated/prisma/client.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function noteWhere(identifier: string) {
  return uuidPattern.test(identifier) ? { OR: [{ id: identifier }, { slug: identifier }] } : { slug: identifier };
}

export async function findNote(prisma: PrismaClient, identifier: string) {
  return prisma.note.findFirst({ where: { ...noteWhere(identifier), status: { not: 'DELETED' } } });
}
