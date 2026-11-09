import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal .env loader. Real environment variables win. */
const file = join(__dirname, '..', '..', '.env');
if (existsSync(file)) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
