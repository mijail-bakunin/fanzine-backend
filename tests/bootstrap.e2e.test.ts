import { createServer } from 'node:net';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestDatabase, databaseUrl, prefix, resetDatabase } from './helpers/test-context.js';

const originalEnvironment = { ...process.env };

beforeAll(resetDatabase);
afterAll(async () => {
  for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  process.exitCode = 0;
  await closeTestDatabase();
});

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No se obtuvo puerto TCP.');
  const port = address.port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

function configure(port: number) {
  Object.assign(process.env, {
    NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port), DATABASE_URL: databaseUrl,
    API_PREFIX: prefix, APP_PUBLIC_URL: 'http://localhost:5173', FRONTEND_ORIGINS: 'http://localhost:5173',
    COOKIE_SECRET: 'bootstrap-cookie-secret-with-thirty-two-characters',
    ANONYMOUS_HMAC_SECRET: 'bootstrap-anonymous-secret-with-thirty-two-characters',
    ANALYTICS_HMAC_SECRET: 'bootstrap-analytics-secret-with-thirty-two-characters',
    CRON_SECRET: 'bootstrap-cron-secret', STORAGE_DRIVER: 'local', LOCAL_STORAGE_PATH: './storage/test-bootstrap',
    PUBLIC_STORAGE_BASE_URL: `http://127.0.0.1:${port}${prefix}/media`, LOG_LEVEL: 'silent',
  });
}

async function importBootstrap(label: string) {
  const url = `${pathToFileURL(path.resolve('src/app.ts')).href}?${label}-${Date.now()}`;
  return import(url) as Promise<{ default: FastifyInstance }>;
}

describe('bootstrap productivo end-to-end', () => {
  it('carga configuración ambiental, crea Prisma y escucha tráfico HTTP real', async () => {
    const port = await freePort();
    configure(port);
    const { default: app } = await importBootstrap('success');
    try {
      const response = await fetch(`http://127.0.0.1:${port}${prefix}/health/ready`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'ready', database: 'connected' });
    } finally {
      await app.close();
      await app.prisma.$disconnect();
    }
  });

  it('captura un conflicto real de puerto sin derribar el proceso', async () => {
    const port = await freePort();
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => { blocker.once('error', reject); blocker.listen(port, '127.0.0.1', resolve); });
    configure(port);
    const previousExitCode = process.exitCode;
    const { default: app } = await importBootstrap('port-conflict');
    try {
      expect(process.exitCode).toBe(1);
      expect(app.server.listening).toBe(false);
    } finally {
      process.exitCode = previousExitCode;
      await app.close();
      await app.prisma.$disconnect();
      await new Promise<void>(resolve => blocker.close(() => resolve()));
    }
  });
});
