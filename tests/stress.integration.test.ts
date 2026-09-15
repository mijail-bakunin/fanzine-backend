import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDatabase, createTestContext, credentials, ids, prefix, prisma, type TestContext } from './helpers/test-context.js';

let context: TestContext;
let baseUrl = '';
const reports: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  context = await createTestContext();
  baseUrl = await context.app.listen({ host: '127.0.0.1', port: 0 });
});
afterEach(async () => { await context.app.close(); });
afterAll(async () => {
  await mkdir(path.resolve('test-results'), { recursive: true });
  await writeFile(path.resolve('test-results/stress-latest.json'), JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
  await closeTestDatabase();
});

function percentile(values: number[], target: number) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * target) - 1)] ?? 0;
}

async function measured(name: string, jobs: Array<() => Promise<Response>>) {
  const started = performance.now();
  const responses = await Promise.all(jobs.map(async job => {
    const requestStarted = performance.now();
    const response = await job();
    return { status: response.status, latencyMs: performance.now() - requestStarted };
  }));
  const durationMs = performance.now() - started;
  const latencies = responses.map(item => item.latencyMs);
  const report = {
    name, requests: jobs.length, durationMs: Number(durationMs.toFixed(2)),
    requestsPerSecond: Number((jobs.length / (durationMs / 1_000)).toFixed(2)),
    p50Ms: Number(percentile(latencies, 0.5).toFixed(2)), p95Ms: Number(percentile(latencies, 0.95).toFixed(2)),
    maxMs: Number(Math.max(...latencies).toFixed(2)), failures: responses.filter(item => item.status >= 400).length,
  };
  reports.push(report);
  return { responses, report };
}

async function login() {
  const response = await fetch(`${baseUrl}${prefix}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials.admin) });
  const cookie = (response.headers.get('set-cookie') ?? '').match(/lg_session=[^;]+/)?.[0] ?? '';
  const body = await response.json() as { csrfToken: string };
  return { cookie, csrfToken: body.csrfToken };
}

describe('estrés y concurrencia HTTP/DB reales', () => {
  it('sostiene una ráfaga mixta de lectura sin errores ni degradación extrema', async () => {
    const routes = [
      '/health',
      '/catalog?pageSize=12&locale=es',
      '/site/settings?locale=en',
      '/editions/n-012-la-libertad/home?locale=es',
      '/editions/current/home?locale=es',
      '/search?q=freedom&locale=en&page=1&pageSize=8',
    ];
    const jobs = Array.from({ length: 160 }, (_, index) => () => fetch(`${baseUrl}${prefix}${routes[index % routes.length]}`));
    const { responses, report } = await measured('public-read-burst', jobs);
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(report.failures).toBe(0);
    expect(report.requestsPerSecond).toBeGreaterThan(10);
    expect(report.p95Ms).toBeLessThan(5_000);
  });

  it('serializa 40 altas editoriales concurrentes sin colisiones ni pérdida de escrituras', async () => {
    const auth = await login();
    const jobs = Array.from({ length: 40 }, (_, index) => () => fetch(`${baseUrl}${prefix}/admin/editions`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: auth.cookie, 'x-csrf-token': auth.csrfToken },
      body: JSON.stringify({ title: `Estrés editorial ${index}`, date: '2028', noteIds: [] }),
    }));
    const { responses, report } = await measured('concurrent-edition-writes', jobs);
    expect(responses.every(response => response.status === 201), JSON.stringify(responses.map(item => item.status))).toBe(true);
    expect(report.p95Ms).toBeLessThan(10_000);
    const editions = await prisma.edition.findMany({ where: { title: { startsWith: 'Estrés editorial' } }, select: { number: true, slug: true } });
    expect(editions).toHaveLength(40);
    expect(new Set(editions.map(item => item.number)).size).toBe(40);
    expect(new Set(editions.map(item => item.slug)).size).toBe(40);
  });

  it('mantiene idempotencia bajo votos concurrentes de una misma identidad', async () => {
    const initial = await fetch(`${baseUrl}${prefix}/notes/${ids.note}/comments/${ids.comment}/upvote`, { method: 'POST' });
    expect(initial.status).toBe(200);
    const voterCookie = (initial.headers.get('set-cookie') ?? '').match(/lg_voter=[^;]+/)?.[0] ?? '';
    expect(voterCookie).not.toBe('');
    const jobs = Array.from({ length: 24 }, () => () => fetch(`${baseUrl}${prefix}/notes/${ids.note}/comments/${ids.comment}/upvote`, { method: 'POST', headers: { cookie: voterCookie } }));
    const { responses } = await measured('idempotent-vote-race', jobs);
    expect(responses.every(response => response.status === 200)).toBe(true);
    expect(await prisma.commentVote.count({ where: { commentId: ids.comment } })).toBe(1);
  });
});
