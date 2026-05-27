import { randomBytes } from 'node:crypto';

/**
 * Short, URL-safe id for an ad's public redirect link (`/go/:id`, DECISION D9).
 * 12 base64url chars ≈ 72 bits — collision-safe at our scale and far shorter than
 * a UUID in the destination URL Facebook sees.
 */
export function generateRedirectId(): string {
  return randomBytes(9).toString('base64url');
}
