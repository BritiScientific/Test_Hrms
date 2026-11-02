import { createApp } from './app';
import { env } from './config/env';
import { pool } from './config/db';

const server = createApp().listen(env.PORT, () => {
  console.log(`HRMS API listening on :${env.PORT}`);
});

const shutdown = () => {
  server.close(() => pool.end().finally(() => process.exit(0)));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
