import { z } from 'zod';

/** The set of offers for a campaign (Phase E). Replaces the campaign's offer list. */
export const offerSetSchema = z.object({
  offers: z
    .array(
      z.object({
        domainId: z.string().uuid(),
        weightPct: z.number().int().min(0).max(100),
        kind: z.enum(['PAID', 'ORGANIC']),
      }),
    )
    .max(20),
});

export type OfferSetInput = z.infer<typeof offerSetSchema>;
