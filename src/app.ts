import { buildApp } from './build-app.js';

const app = await buildApp();

try {
  await app.listen({ host: app.config.host, port: app.config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}

export default app;
