/**
 * Whop API errors. Whop answers with `{ error: { type, message, code? } }` and a status code; we map
 * that to a small set of KINDS so callers react by kind, not by string-matching messages.
 */
export type WhopErrorKind =
  /** 401: the key is missing, wrong or revoked. The connection is broken until the user re-enters it. */
  | 'auth'
  /** 403: the key is valid but lacks a permission, or belongs to another business. */
  | 'permission'
  | 'not_found'
  | 'conflict'
  /** 400 / 422: the request (or the account's state) was refused. Whop's message says what to fix. */
  | 'validation'
  /** 402: not enough balance for a paid call (carries `depositUrl`). */
  | 'payment_required'
  | 'rate_limited'
  | 'server'
  /** The request never got an answer (DNS, reset, offline). */
  | 'network'
  /** Our own timeout elapsed first. */
  | 'timeout';

export function whopErrorKind(status: number): WhopErrorKind {
  if (status === 401) return 'auth';
  if (status === 402) return 'payment_required';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  return 'validation'; // 400, 422 and any other 4xx
}

export interface WhopErrorInfo {
  status: number;
  /** Whop's machine-readable `error.type`, e.g. `rate_limit_exceeded`. */
  type?: string;
  /** Whop's `error.code`, when the refusal carries one. */
  code?: string;
  retryAfterMs?: number;
  /** For 402: where the user tops up. */
  depositUrl?: string;
  method?: string;
  path?: string;
}

export class WhopApiError extends Error {
  override readonly name = 'WhopApiError';
  readonly kind: WhopErrorKind;
  readonly status: number;
  readonly type?: string;
  readonly code?: string;
  readonly retryAfterMs?: number;
  readonly depositUrl?: string;
  readonly method?: string;
  readonly path?: string;

  constructor(kind: WhopErrorKind, message: string, info: WhopErrorInfo) {
    super(message);
    this.kind = kind;
    this.status = info.status;
    this.type = info.type;
    this.code = info.code;
    this.retryAfterMs = info.retryAfterMs;
    this.depositUrl = info.depositUrl;
    this.method = info.method;
    this.path = info.path;
  }
}

export function isWhopError(err: unknown): err is WhopApiError {
  return err instanceof WhopApiError;
}

/** Pull `{ type, code, message, depositUrl }` out of a Whop error body. Never throws. */
export function parseWhopErrorBody(text: string): { type?: string; code?: string; message?: string; depositUrl?: string } {
  if (!text) return {};
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const inner = (body.error && typeof body.error === 'object' ? body.error : body) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    return {
      type: str(inner.type),
      code: str(inner.code),
      message: str(inner.message) ?? str(body.message),
      depositUrl: str(inner.deposit_url) ?? str(body.deposit_url),
    };
  } catch {
    return {};
  }
}

const UNIT_MS: Record<string, number> = { s: 1000, sec: 1000, second: 1000, m: 60_000, min: 60_000, minute: 60_000, h: 3_600_000, hour: 3_600_000 };

/**
 * How long Whop asked us to wait: the `Retry-After` header (seconds or an HTTP date), else the
 * sentence in the 429 message ("Try again in 12 seconds.").
 */
export function retryAfterMs(headers: { get(name: string): string | null }, message?: string, now: () => number = Date.now): number | undefined {
  const header = headers.get('retry-after');
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.max(0, at - now());
  }
  if (message) {
    const m = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|h)\b/i.exec(message);
    if (m) {
      const unit = UNIT_MS[(m[2] ?? 's').toLowerCase().replace(/s$/, '')] ?? 1000;
      return Math.round(Number(m[1]) * unit);
    }
  }
  return undefined;
}
