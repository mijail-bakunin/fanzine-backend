import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDatabase, createTestContext, prefix, type TestContext } from './helpers/test-context.js';

let context: TestContext;
beforeEach(async () => { context = await createTestContext(); });
afterEach(async () => { await context.app.close(); });
afterAll(closeTestDatabase);

async function sourceFiles(directory = path.resolve('src')): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !absolute.includes(`${path.sep}generated${path.sep}`)) files.push(absolute);
  }
  return files;
}

function relativeImports(source: string) {
  return [...source.matchAll(/(?:from\s+|import\s*\()(['"])(\.[^'"]+)\1/g)].map(match => match[2]!);
}

describe('arquitectura estática y dependencias', () => {
  it('no contiene ciclos entre módulos productivos ni dependencias hacia tests/frontend', async () => {
    const files = await sourceFiles();
    const normalized = new Map(files.map(file => [file.replace(/\.ts$/, ''), file]));
    const graph = new Map<string, string[]>();
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      expect(source).not.toMatch(/(?:tests|referenced-chatgpt-conversation-this-is-an|src\/api)/i);
      const dependencies = relativeImports(source).map(specifier => {
        const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/, ''));
        return normalized.get(resolved);
      }).filter((value): value is string => Boolean(value));
      graph.set(file, dependencies);
    }
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (file: string, chain: string[]) => {
      if (visiting.has(file)) throw new Error(`Ciclo: ${[...chain, file].map(item => path.relative(process.cwd(), item)).join(' -> ')}`);
      if (visited.has(file)) return;
      visiting.add(file);
      for (const dependency of graph.get(file) ?? []) visit(dependency, [...chain, file]);
      visiting.delete(file);
      visited.add(file);
    };
    for (const file of files) visit(file, []);
    expect(visited.size).toBe(files.length);
  });

  it('mantiene secretos, sesiones y borrado lógico en el modelo relacional', async () => {
    const schema = await readFile(path.resolve('prisma/schema.prisma'), 'utf8');
    for (const model of ['Edition', 'Note', 'Category', 'Resource']) {
      const block = schema.match(new RegExp(`model ${model} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
      expect(block, model).toContain('status');
      expect(block, model).toContain('deletedAt');
    }
    const user = schema.match(/model User \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const session = schema.match(/model Session \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const reset = schema.match(/model PasswordResetToken \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const comment = schema.match(/model Comment \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const edition = schema.match(/model Edition \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(user).toContain('passwordHash');
    expect(user).not.toMatch(/\n\s+password\s+/);
    expect(session).toContain('tokenHash');
    expect(session).not.toMatch(/\n\s+token\s+/);
    expect(reset).toContain('tokenHash');
    expect(reset).not.toMatch(/\n\s+token\s+/);
    expect(comment).toContain('parentId');
    expect(comment).toContain('@relation("CommentReplies"');
    expect(comment).toContain('deletedAt');
    expect(comment).toContain('moderationEmailStatus');
    expect(schema).toMatch(/enum CommentStatus \{[\s\S]*DELETED/);
    expect(schema).toContain('enum CommentEmailStatus');
    expect(comment).toContain('replies');
    expect(edition).toContain('coverArt');
    expect(schema.match(/model Note \{([\s\S]*?)\n\}/)?.[1] ?? '').toContain('coverTypography');
  });
});

describe('arquitectura HTTP y OpenAPI', () => {
  it('no registra rutas duplicadas y conserva el prefijo público único', async () => {
    const routes = context.app.printRoutes({ commonPrefix: false });
    const document = (await context.app.inject({ method: 'GET', url: '/documentation/json' })).json() as { paths: Record<string, Record<string, unknown>> };
    const routeCount = Object.values(document.paths).reduce((total, item) => total + Object.keys(item).filter(method => ['get', 'post', 'patch', 'delete', 'put'].includes(method)).length, 0);
    expect(routeCount).toBeGreaterThan(45);
    expect(routes).not.toContain('/api/api/');
    expect(routes).not.toContain('src/api');
  });

  it('documenta cada operación con operationId único, respuestas y seguridad explícita', async () => {
    const response = await context.app.inject({ method: 'GET', url: '/documentation/json' });
    expect(response.statusCode).toBe(200);
    const document = response.json() as { paths: Record<string, Record<string, Record<string, unknown>>>; components: Record<string, unknown>; 'x-documentation': { undocumentedOperations: string[] } };
    const operations = Object.entries(document.paths).flatMap(([pathname, pathItem]) => Object.entries(pathItem)
      .filter(([method]) => ['get', 'post', 'patch', 'delete', 'put'].includes(method))
      .map(([, operation]) => ({ pathname, operation })));
    const operationIds = operations.map(item => item.operation.operationId as string);
    expect(operationIds.every(Boolean)).toBe(true);
    expect(new Set(operationIds).size).toBe(operationIds.length);
    expect(operations.every(item => Object.keys(item.operation.responses as object).some(status => /^2\d\d$/.test(status)) || Object.keys(item.operation.responses as object).includes('501'))).toBe(true);
    expect(operations.every(item => item.pathname === '/health' || Object.keys(item.operation.responses as object).some(status => /^[45]\d\d$/.test(status)))).toBe(true);
    expect(document['x-documentation'].undocumentedOperations).toEqual([]);
    expect(document.components).toHaveProperty('securitySchemes');
    expect(document.components).toHaveProperty('schemas.CoverArt');
    expect(document.components).toHaveProperty('schemas.CoverArtPatch');
    expect(document.components).toHaveProperty('schemas.CoverTypography');
    expect(document.components).toHaveProperty('schemas.CoverTypographyPatch');
  });
});
