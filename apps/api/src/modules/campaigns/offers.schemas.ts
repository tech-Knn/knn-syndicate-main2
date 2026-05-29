import { z } from 'zod';

/** The set of offers for a campaign (Phase E). Replaces the campaign's offer list. */
export const offerSetSchema = z.object({
  offers: z
    .array(
      z.object({
        domainId: z.string().uuid(),
        weightPct: z.number().int().min(0).max(100),
        kind: z.enum(['PAID', 'ORGANIC']),
        /** Optional article variant (A/B). Null/omitted → the campaign's default article. */
        articleId: z.string().uuid().nullish(),
      }),
    )
    .max(20),
});

export type OfferSetInput = z.infer<typeof offerSetSchema>;

/** Live (post-launch) offer edit — existing offers carry their `id`; new ones omit it. */
export const liveOfferSetSchema = z.object({
  offers: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        domainId: z.string().uuid(),
        weightPct: z.number().int().min(0).max(100),
        kind: z.enum(['PAID', 'ORGANIC']),
        articleId: z.string().uuid().nullish(),
      }),
    )
    .max(20),
});
