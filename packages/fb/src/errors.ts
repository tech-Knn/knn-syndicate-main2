import { FB_RATE_LIMIT_ERROR_CODES, FB_TOKEN_ERROR_SUBCODES } from '@knn/shared';

export interface FbErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
}

interface FbErrorOpts {
  code?: number;
  subcode?: number;
  httpStatus?: number;
  fbtraceId?: string;
}

export class FbApiError extends Error {
  readonly code?: number;
  readonly subcode?: number;
  readonly httpStatus?: number;
  readonly fbtraceId?: string;

  constructor(message: string, opts: FbErrorOpts = {}) {
    super(message);
    this.name = 'FbApiError';
    this.code = opts.code;
    this.subcode = opts.subcode;
    this.httpStatus = opts.httpStatus;
    this.fbtraceId = opts.fbtraceId;
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

const tokenSubcodes = FB_TOKEN_ERROR_SUBCODES as readonly number[];
const rateCodes = FB_RATE_LIMIT_ERROR_CODES as readonly number[];

/** Map a Facebook Graph API error body into the right typed error. */
export function classifyFbError(
  body: FbErrorBody,
  httpStatus?: number,
  retryAfterMs?: number,
): FbApiError {
  const code = body.code;
  const subcode = body.error_subcode;
  const message = body.message ?? 'Facebook API error';
  const opts: FbErrorOpts = { code, subcode, httpStatus, fbtraceId: body.fbtrace_id };

  if (code === 190 || (subcode !== undefined && tokenSubcodes.includes(subcode))) {
    return new FbConnectionBrokenError(message, opts);
  }
  if (code !== undefined && rateCodes.includes(code)) {
    return new FbRateLimitError(message, { ...opts, retryAfterMs });
  }
  return new FbApiError(message, opts);
}
