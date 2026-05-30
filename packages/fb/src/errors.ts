import {
  FB_ACCOUNT_RESTRICTED_ERROR_CODES,
  FB_ACCOUNT_RESTRICTED_SUBCODES,
  FB_RATE_LIMIT_ERROR_CODES,
  FB_TOKEN_ERROR_SUBCODES,
} from '@knn/shared';

export interface FbErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
  /** On checkpoint errors (190/459) FB returns the URL the user must visit to clear it. */
  error_data?: { url?: string } | string;
}

interface FbErrorOpts {
  code?: number;
  subcode?: number;
  httpStatus?: number;
  fbtraceId?: string;
  userTitle?: string;
  userMessage?: string;
  /** A checkpoint/authentication URL the account owner must visit, when FB provides one. */
  checkpointUrl?: string;
}

export class FbApiError extends Error {
  readonly code?: number;
  readonly subcode?: number;
  readonly httpStatus?: number;
  readonly fbtraceId?: string;
  /** Facebook's human-facing error_user_title / error_user_msg, when present. */
  readonly userTitle?: string;
  readonly userMessage?: string;
  readonly checkpointUrl?: string;

  constructor(message: string, opts: FbErrorOpts = {}) {
    super(message);
    this.name = 'FbApiError';
    this.code = opts.code;
    this.subcode = opts.subcode;
    this.httpStatus = opts.httpStatus;
    this.fbtraceId = opts.fbtraceId;
    this.userTitle = opts.userTitle;
    this.userMessage = opts.userMessage;
    this.checkpointUrl = opts.checkpointUrl;
  }
}

/**
 * A stored FB/Google token could not be decrypted: the `TOKEN_ENCRYPTION_KEY` changed
 * (rotation) or the stored ciphertext is corrupt. Intentionally NOT an `FbApiError` — no
 * Graph call ever happened, so it must not be funneled into FB-error handling (rate-limit
 * retries, breaker, `instanceof FbApiError` worker logic). Callers map it to a clean
 * "reconnect the account" response instead of leaking a raw Node crypto error (e.g.
 * `ERR_CRYPTO_INVALID_AUTH_TAG`). Carries no token material.
 */
export class TokenDecryptError extends Error {
  constructor(
    message = 'Stored access token could not be decrypted — the encryption key changed or the stored value is corrupt. Reconnect the account.',
  ) {
    super(message);
    this.name = 'TokenDecryptError';
  }
}

/** Token expired / revoked / password change / app removed (err 190 + subcodes). */
export class FbConnectionBrokenError extends FbApiError {
  constructor(message: string, opts: FbErrorOpts = {}) {
    super(message, opts);
    this.name = 'FbConnectionBrokenError';
  }
}

/** Business-Use-Case / app / custom rate limit hit (codes 4/17/32/613/80000/80003/80004). */
export class FbRateLimitError extends FbApiError {
  readonly retryAfterMs?: number;
  constructor(message: string, opts: FbErrorOpts & { retryAfterMs?: number } = {}) {
    super(message, opts);
    this.name = 'FbRateLimitError';
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * The ad account is under a Facebook security/policy hold (code 368, "authenticate your
 * account in Ads Manager"). The TOKEN is fine and reads/existing ads keep running — only
 * create/modify is blocked until the account owner re-authenticates in the Ads Manager UI.
 * Distinct from FbConnectionBrokenError (token break) so the app surfaces an actionable
 * message and STOPS retrying (retries make the checkpoint worse) rather than looping.
 */
export class FbAccountRestrictedError extends FbApiError {
  constructor(message: string, opts: FbErrorOpts = {}) {
    super(message, opts);
    this.name = 'FbAccountRestrictedError';
  }
}

const tokenSubcodes = FB_TOKEN_ERROR_SUBCODES as readonly number[];
const rateCodes = FB_RATE_LIMIT_ERROR_CODES as readonly number[];
const restrictedCodes = FB_ACCOUNT_RESTRICTED_ERROR_CODES as readonly number[];
const restrictedSubcodes = FB_ACCOUNT_RESTRICTED_SUBCODES as readonly number[];

/** Pull the checkpoint URL out of FB's `error_data` (string or `{url}`), if present. */
function extractCheckpointUrl(body: FbErrorBody): string | undefined {
  const d = body.error_data;
  if (!d) return undefined;
  if (typeof d === 'string') return d.startsWith('http') ? d : undefined;
  return d.url;
}

/** Map a Facebook Graph API error body into the right typed error. */
export function classifyFbError(
  body: FbErrorBody,
  httpStatus?: number,
  retryAfterMs?: number,
): FbApiError {
  const code = body.code;
  const subcode = body.error_subcode;
  const message = body.message ?? 'Facebook API error';
  const opts: FbErrorOpts = {
    code,
    subcode,
    httpStatus,
    fbtraceId: body.fbtrace_id,
    userTitle: body.error_user_title,
    userMessage: body.error_user_msg,
    checkpointUrl: extractCheckpointUrl(body),
  };

  if (code === 190 || (subcode !== undefined && tokenSubcodes.includes(subcode))) {
    return new FbConnectionBrokenError(message, opts);
  }
  // Account security/policy hold (368 "authenticate your account") — token is fine, but
  // create/modify is blocked. Checked before the generic fallback so the launcher can
  // surface the Ads-Manager re-auth step and stop retrying.
  if (
    (code !== undefined && restrictedCodes.includes(code)) ||
    (subcode !== undefined && restrictedSubcodes.includes(subcode))
  ) {
    return new FbAccountRestrictedError(message, opts);
  }
  if (code !== undefined && rateCodes.includes(code)) {
    return new FbRateLimitError(message, { ...opts, retryAfterMs });
  }
  return new FbApiError(message, opts);
}
