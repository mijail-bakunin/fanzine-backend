import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async app => {
  app.get('/health', async () => ({ status: 'ok', service: 'backend-guillotina', timestamp: new Date().toISOString() }));
  app.get('/health/ready', async (_request, reply) => {
    await app.prisma.$queryRaw`SELECT 1`;
    return reply.send({ status: 'ready', database: 'connected' });
  });
};
