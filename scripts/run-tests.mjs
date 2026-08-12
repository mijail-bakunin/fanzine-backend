import { spawnSync } from 'node:child_process';

const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? 'postgresql://guillotina:guillotina_dev@localhost:5432/laguillotina_test?schema=public';
const environment = { ...process.env, DATABASE_URL: testDatabaseUrl, TEST_DATABASE_URL: testDatabaseUrl, NODE_ENV: 'test' };

function run(command) {
  const result = spawnSync(command, { stdio: 'inherit', env: environment, shell: true });
  if (result.error) console.error(result.error);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npx prisma migrate deploy');
run('npx vitest run');
