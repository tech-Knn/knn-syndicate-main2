import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/** Walk up from a starting dir until we find the monorepo root (pnpm-workspace.yaml). */
function findRepoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start; // hit filesystem root; fall back
    dir = parent;
  }
}

const repoRoot = findRepoRoot(process.cwd());

// Load base .env then an optional per-environment override (.env.<APP_ENV>).
loadDotenv({ path: join(repoRoot, '.env') });
const appEnvGuess = process.env.APP_ENV ?? 'local';
const overridePath = join(repoRoot, `.env.${appEnvGuess}`);
if (existsSync(overridePath)) {
  loadDotenv({ path: overridePath, override: true });
}

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1');

const optionalString = z.string().trim().optional().default('');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'staging', 'production']).default('local'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Rate limiting (Phase 11) — per-IP/min. Auth endpoints get a tighter cap (brute-force).
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(200),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(20),

  // Ports
  API_PORT: z.coerce.number().int().positive().default(3000),
  ARTICLE_PORT: z.coerce.number().int().positive().default(3001),
  REDIRECT_PORT: z.coerce.number().int().positive().default(3002),
  WEB_PORT: z.coerce.number().int().positive().default(3003),

  // Domains
  PLATFORM_DOMAIN: z.string().url().default('http://localhost:3000'),
  WEB_DOMAIN: z.string().url().default('http://localhost:3003'),
  ARTICLE_DOMAIN: z.string().url().default('http://localhost:3001'),
  REDIRECT_DOMAIN: z.string().url().default('http://localhost:3002'),

  // Data stores
  // Owner/superuser connection — used for migrations and the role bootstrap.
  DATABASE_URL: z.string().min(1),
  // App runtime connection — a NON-superuser role so RLS is enforced. Falls back
  // to DATABASE_URL if unset (e.g. before the app role is bootstrapped).
  APP_DATABASE_URL: z.string().min(1).optional(),
  SHADOW_DATABASE_URL: optionalString,
  REDIS_URL: z.string().min(1),

  // Auth / crypto
  JWT_ACCESS_SECRET: z.string().min(16),
  JWT_REFRESH_SECRET: z.string().min(16),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  TOKEN_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'TOKEN_ENCRYPTION_KEY must be 64 hex chars (32 bytes)'),

  // Bull-Board
  BULL_BOARD_USER: z.string().default('admin'),
  BULL_BOARD_PASSWORD: z.string().default('admin'),

  // Facebook
  FB_APP_ID: optionalString,
  FB_APP_SECRET: optionalString,
  FB_API_VERSION: z.string().default('v21.0'),
  FB_OAUTH_REDIRECT_URI: optionalString,
  // Facebook Login for Business: the saved login-configuration id. When set, the
  // OAuth dialog requests permissions from that config instead of a `scope` list.
  FB_LOGIN_CONFIG_ID: optionalString,
  FB_WEBHOOK_VERIFY_TOKEN: optionalString,

  // Google / AdSense
  GOOGLE_CLIENT_ID: optionalString,
  GOOGLE_CLIENT_SECRET: optionalString,
  GOOGLE_OAUTH_REDIRECT_URI: optionalString,

  // AI
  ANTHROPIC_API_KEY: optionalString,
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  OPENAI_API_KEY: optionalString,
  OPENAI_EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  // Article generation + compliance model (cost-optimized; gpt-4.1-mini ≈ ⅓¢/article).
  OPENAI_ARTICLE_MODEL: z.string().default('gpt-4.1-mini'),

  // FX
  FX_API_URL: z.string().default('https://api.exchangerate.host'),
  FX_API_KEY: optionalString,

  // Cloudflare KV (Phase 7/8): the origin writes per-ad redirect configs to the
  // edge Worker's KV namespace at launch. Token needs "Workers KV Storage: Edit".
  CLOUDFLARE_ACCOUNT_ID: optionalString,
  CLOUDFLARE_API_TOKEN: optionalString,
  CF_KV_NAMESPACE_ID: optionalString,

  // Internal worker→API trigger (Phase 8 auto-launch): the worker calls the API's
  // internal launch endpoint. Token is a shared secret; URL is the API's address
  // (internal docker hostname in staging, e.g. http://api:3000).
  INTERNAL_API_TOKEN: optionalString,
  INTERNAL_API_URL: z.string().default('http://localhost:3000'),

  // Storage
  UPLOAD_DIR: z.string().default('./var/uploads'),

  // Business
  BUSINESS_TIMEZONE: z.string().default('Asia/Kolkata'),

  // Derived helper flags
  CI: booleanish.optional(),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export const env: Env = loadEnv();

export const isProd = env.APP_ENV === 'production';
export const isStaging = env.APP_ENV === 'staging';
export const isLocal = env.APP_ENV === 'local';

export { repoRoot };

/** Read the monorepo package version (handy for health/version endpoints). */
export function rootVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
