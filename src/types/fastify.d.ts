import type { AppConfig } from '../config/env.js';
import type { PrismaClient, UserRole } from '../generated/prisma/client.js';

export type RequestAuth = {
  session: {
    id: string;
    userId: string;
    csrfHash: string;
    expiresAt: Date;
  };
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    role: UserRole;
  };
};

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig;
    prisma: PrismaClient;
  }

  interface FastifyRequest {
    auth: RequestAuth | null;
  }
}
