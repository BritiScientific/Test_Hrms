import { createApp } from './app';
import { env } from './config/env';
import { pool, verifyDatabaseConnection } from './config/db';

async function main() {
  // Authenticate against Postgres BEFORE accepting traffic; any failure aborts startup.
  await verifyDatabaseConnection();
  console.log('Database connected');

  const server = createApp().listen(env.PORT, () => console.log(`HRMS API listening on :${env.PORT}`));

  const shutdown = () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: Error) => {
  console.error(`Startup aborted: ${err.message}`);
  process.exit(1);
});
