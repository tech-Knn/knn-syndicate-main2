import { type WhopApiError } from '@knn/whop';
import { AppError } from './errors.js';

/**
 * Turn a Whop API failure into the HTTP answer a user should see. Whop's own messages are already
 * written to say what to fix ("A Facebook page is required", "Connect an ads payment method before
 * launching"), so validation failures pass them through. Nothing here ever contains the API key.
 */
export function whopToAppError(err: WhopApiError): AppError {
  const info = { whop: { kind: err.kind, status: err.status } };
  switch (err.kind) {
    case 'auth':
      return new AppError(409, 'Whop rejected the API key. Reconnect with a working key.', info);
    case 'permission':
      return new AppError(409, err.message, info);
    case 'validation':
      return new AppError(400, err.message, info);
    case 'payment_required':
      return new AppError(402, err.message, { ...info, depositUrl: err.depositUrl });
    case 'rate_limited':
      return new AppError(429, 'Whop is limiting requests right now. Try again in a minute.', { ...info, retryAfterMs: err.retryAfterMs });
    case 'not_found':
      return new AppError(404, err.message, info);
    case 'conflict':
      return new AppError(409, err.message, info);
    default:
      return new AppError(502, 'Whop is not responding. Try again in a minute.', info);
  }
}
