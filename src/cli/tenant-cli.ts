/**
 * Platform CLI for organization provisioning (runs as hrms_owner, never as the API role).
 *
 *   npm run tenant:provision -- --name "Acme Corp" --admin-email ceo@acme.test --admin-name "Ana Silva" \
 *        [--slug acme-corp] [--legal-name "Acme Corporation Pvt Ltd"] [--timezone Asia/Kolkata] [--country IN] [--ttl-hours 72]
 *   npm run tenant:invite -- --slug acme-corp --email ceo@acme.test --name "Ana Silva" [--ttl-hours 72]
 *
 * Prints a one-time activation link. Deliver it to the administrator over a
 * trusted channel: whoever holds it can activate the Tenant Admin account.
 *
 * Connection: OWNER_DATABASE_URL, or DATABASE_URL with the user switched to
 * hrms_owner / OWNER_PASSWORD.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { inviteTenantAdmin, provisionOrganization, slugify } from '../modules/onboarding/provisioning';

loadDotEnv();

function loadDotEnv() {
  const file = join(__dirname, '..', '..', '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function ownerUrl(): string {
  if (process.env.OWNER_DATABASE_URL) return process.env.OWNER_DATABASE_URL;
  const u = new URL(process.env.DATABASE_URL ?? 'postgres://hrms_app@localhost:5432/hrms');
  u.username = 'hrms_owner';
  u.password = process.env.OWNER_PASSWORD ?? 'change_me_owner';
  return u.toString();
}

function args(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      out[a.slice(2)] = next && !next.startsWith('--') ? (i++, next) : 'true';
    }
  }
  return out;
}

function need(a: Record<string, string>, k: string): string {
  if (!a[k]) {
    console.error(`Missing --${k}`);
    process.exit(2);
  }
  return a[k];
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const a = args(rest);
  const base = (process.env.APP_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
  const client = new pg.Client({ connectionString: ownerUrl() });
  await client.connect();
  try {
    if (command === 'create') {
      const name = need(a, 'name');
      const r = await provisionOrganization(client, {
        displayName: name,
        legalName: a['legal-name'],
        slug: a.slug ?? slugify(name),
        timezone: a.timezone,
        countryCode: a.country?.toUpperCase(),
        adminEmail: need(a, 'admin-email'),
        adminName: need(a, 'admin-name'),
        inviteTtlHours: a['ttl-hours'] ? Number(a['ttl-hours']) : undefined,
      });
      console.log(`Organization created: id=${r.tenantId} slug=${r.slug}`);
      console.log(`Activation link (expires ${r.invitation.expiresAt.toISOString()}):`);
      console.log(`  ${base}/activate?token=${r.invitation.token}`);
    } else if (command === 'invite') {
      const r = await inviteTenantAdmin(client, {
        slug: need(a, 'slug'),
        email: need(a, 'email'),
        name: need(a, 'name'),
        ttlHours: a['ttl-hours'] ? Number(a['ttl-hours']) : undefined,
      });
      console.log(`Invitation created for organization id=${r.tenantId}`);
      console.log(`Activation link (expires ${r.invitation.expiresAt.toISOString()}):`);
      console.log(`  ${base}/activate?token=${r.invitation.token}`);
    } else {
      console.error('Usage: tenant-cli create --name ... --admin-email ... --admin-name ... | invite --slug ... --email ... --name ...');
      process.exit(2);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e?.issues ? JSON.stringify(e.issues, null, 2) : e?.message ?? e);
  process.exit(1);
});
