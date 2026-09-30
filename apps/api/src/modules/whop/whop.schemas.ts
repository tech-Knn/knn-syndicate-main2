import { WHOP_BIZ_ID_RE, WHOP_ENVIRONMENTS } from '@knn/shared';
import { z } from 'zod';

export const connectSchema = z.object({
  bizId: z.string().trim().regex(WHOP_BIZ_ID_RE, 'The business ID looks like biz_ followed by letters and numbers.'),
  apiKey: z.string().trim().min(8, 'Paste the full API key.').max(500),
  label: z.string().trim().max(80).optional(),
  environment: z.enum(WHOP_ENVIRONMENTS).default('PRODUCTION'),
});

export const metaConnectSchema = z.object({ redirectUrl: z.string().url() });

export const pixelCheckSchema = z.object({ url: z.string().url().optional() });
