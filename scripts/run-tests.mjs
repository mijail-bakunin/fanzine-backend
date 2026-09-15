import { spawnSync } from 'node:child_process';
import 'dotenv/config';

const testPostgresPort = process.env.POSTGRES_PORT ?? '5432';
const testDatabaseUrl = (process.env.TEST_DATABASE_URL ?? `postgresql://guillotina:guillotina_dev@127.0.0.1:${testPostgresPort}/laguillotina_test?schema=public`).replace('localhost', '127.0.0.1');
const environment = { ...process.env, DATABASE_URL: testDatabaseUrl, TEST_DATABASE_URL: testDatabaseUrl, NODE_ENV: 'test' };
const argumentsFromCli = process.argv.slice(2);
const suiteArgument = argumentsFromCli.find(argument => argument.startsWith('--suite='));
const suite = suiteArgument?.slice('--suite='.length) ?? 'all';
const suites = {
  all: [],
  architecture: ['tests/architecture.test.ts'],
  integration: [
    'tests/api.integration.test.ts', 'tests/admin.integration.test.ts', 'tests/auth-security.integration.test.ts',
    'tests/public-community.integration.test.ts', 'tests/files-analytics.integration.test.ts', 'tests/s3-minio.integration.test.ts',
    'tests/assistant.integration.test.ts',
  ],
  e2e: ['tests/e2e.http.test.ts', 'tests/bootstrap.e2e.test.ts'],
  stress: ['tests/stress.integration.test.ts'],
  edge: ['tests/coverage-edges.test.ts'],
};

if (argumentsFromCli.some(argument => argument !== '--coverage' && !argument.startsWith('--suite=')) || !(suite in suites)) {
  console.error(`Argumentos inválidos. Suites disponibles: ${Object.keys(suites).join(', ')}.`);
  process.exit(2);
}

function run(command) {
  const result = spawnSync(command, { stdio: 'inherit', env: environment, shell: true });
  if (result.error) console.error(result.error);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npx prisma migrate deploy');
const files = suites[suite].join(' ');
run(`npx vitest run${files ? ` ${files}` : ''}${argumentsFromCli.includes('--coverage') ? ' --coverage' : ''}`);
