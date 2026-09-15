import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { PrismaClient } from './generated/prisma/client.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { toHttpError } from './lib/errors.js';
import { createPrismaClient } from './lib/prisma.js';
import { enrichOpenApi } from './openapi/documentation.js';
import { hydrateAuth } from './modules/auth/auth-context.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { publicContentRoutes } from './modules/content/public.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { resourceRoutes } from './modules/resources/resource.routes.js';
import { internalAnalyticsRoutes } from './modules/analytics/internal.routes.js';
import { assistantRoutes } from './modules/assistant/assistant.routes.js';
import { healthRoutes } from './routes/health.routes.js';

export type BuildAppOptions = {
  config?: AppConfig;
  prisma?: PrismaClient;
  logger?: boolean;
};

export async function buildApp(options: BuildAppOptions = {}) {
  const config = options.config ?? loadConfig();
  if (config.nodeEnv === 'production' && config.storageDriver === 'local') {
    throw new Error('STORAGE_DRIVER=local no está permitido en producción. Configurá S3/R2.');
  }
  const prisma = options.prisma ?? createPrismaClient(config.databaseUrl);
  const app = Fastify({
    trustProxy: config.trustProxy,
    bodyLimit: 1_048_576,
    logger: options.logger === false ? false : {
      level: config.logLevel,
      redact: {
        paths: [
          'req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie',
          'body.password', 'body.currentPassword', 'body.newPassword', 'body.token',
        ],
        censor: '[REDACTED]',
      },
    },
  });
  app.decorate('config', config);
  app.decorate('prisma', prisma);
  app.decorateRequest('auth', null);

  app.setNotFoundHandler((request, reply) => reply.code(404).send({
    error: { code: 'ROUTE_NOT_FOUND', message: 'La ruta solicitada no existe.', requestId: request.id },
  }));

  app.setErrorHandler(async (error, request, reply) => {
    const httpError = toHttpError(error);
    if (httpError.statusCode >= 500) {
      request.log.error({ err: error, requestId: request.id }, 'Request failed');
      try {
        await app.prisma.errorLog.create({ data: {
          code: httpError.code, message: httpError.message, route: request.routeOptions.url,
          method: request.method, statusCode: httpError.statusCode, requestId: request.id,
        } });
      } catch (loggingError) {
        request.log.error({ err: loggingError, requestId: request.id }, 'Could not persist error log');
      }
    }
    return reply.code(httpError.statusCode).send({
      error: { code: httpError.code, message: httpError.message, details: httpError.details, requestId: request.id },
    });
  });

  await app.register(cookie, { secret: config.cookieSecret, hook: 'onRequest' });
  await app.register(cors, {
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    origin(origin, callback) {
      if (!origin || config.frontendOrigins.includes(origin.replace(/\/$/, ''))) callback(null, true);
      else callback(new Error('Origen no permitido por CORS.'), false);
    },
  });
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute', ban: 3 });
  await app.register(multipart, {
    limits: { files: 1, fields: 20, fileSize: config.maxVideoBytes, parts: 25 },
    throwFileSizeLimit: true,
  });
  await app.register(swagger, {
    openapi: {
      info: { title: 'La Guillotina API', version: '1.0.0', description: 'API editorial, comunidad y administración.' },
      servers: [{ url: config.apiPrefix }],
    },
    transformObject: documentObject => enrichOpenApi((documentObject as { openapiObject: Parameters<typeof enrichOpenApi>[0] }).openapiObject),
  });
  await app.register(swaggerUi, { routePrefix: '/documentation' });

  if (config.storageDriver === 'local') {
    const root = path.resolve(config.localStoragePath);
    await mkdir(root, { recursive: true });
    await app.register(fastifyStatic, { root, prefix: `${config.apiPrefix}/media/`, decorateReply: false });
  }

  app.addHook('preHandler', hydrateAuth);
  await app.register(healthRoutes, { prefix: config.apiPrefix });
  await app.register(authRoutes, { prefix: config.apiPrefix });
  await app.register(publicContentRoutes, { prefix: config.apiPrefix });
  await app.register(assistantRoutes, { prefix: config.apiPrefix });
  await app.register(adminRoutes, { prefix: config.apiPrefix });
  await app.register(resourceRoutes, { prefix: config.apiPrefix });
  await app.register(internalAnalyticsRoutes, { prefix: config.apiPrefix });

  return app;
}
