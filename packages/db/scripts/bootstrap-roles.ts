import { Client } from 'pg';
import { env } from '@knn/config';

/**
 * Provisions the NON-superuser application role (from APP_DATABASE_URL) so that
 * Row-Level Security is actually enforced — the default Postgres superuser
 * bypasses RLS. Idempotent: safe to run on every deploy. Run AFTER migrations
 * (it grants on existing tables; default privileges cover future ones).
 *
 * Connects as the owner/superuser (DATABASE_URL). Identifiers/passwords come
 * from our own validated env, but are still quoted defensively.
 */
function parseUrl(url: string): { user: string; password: string } {
  const u = new URL(url);
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const quoteLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

async function main(): Promise<void> {
  const appUrl = env.APP_DATABASE_URL;
  if (!appUrl) {
    console.log('APP_DATABASE_URL is not set — skipping app-role bootstrap.');
    return;
  }

  const owner = parseUrl(env.DATABASE_URL).user;
  const app = parseUrl(appUrl);
  const role = quoteIdent(app.user);

  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [app.user]);
    if (existing.rowCount === 0) {
      await client.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD ${quoteLiteral(app.password)}`,
      );
      console.log(`Created role "${app.user}".`);
    } else {
      await client.query(
        `ALTER ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${quoteLiteral(app.password)}`,
      );
      console.log(`Updated existing role "${app.user}".`);
    }

    const statements = [
      `GRANT USAGE ON SCHEMA public TO ${role}`,
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${role}`,
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${role}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(owner)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${role}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdent(owner)} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${role}`,
    ];
    for (const sql of statements) await client.query(sql);

    console.log(
      `Bootstrapped app role "${app.user}" (NOSUPERUSER, NOBYPASSRLS) with DML grants + default privileges.`,
    );
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
