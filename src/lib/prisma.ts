import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

declare global {
  // eslint-disable-next-line no-var
  var guillotinaPrisma: PrismaClient | undefined;
}

export function createPrismaClient(databaseUrl: string) {
  if (globalThis.guillotinaPrisma) return globalThis.guillotinaPrisma;
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    max: process.env.NODE_ENV === 'production' ? 5 : 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
  });
  const client = new PrismaClient({ adapter });
  if (process.env.NODE_ENV !== 'test') globalThis.guillotinaPrisma = client;
  return client;
}
