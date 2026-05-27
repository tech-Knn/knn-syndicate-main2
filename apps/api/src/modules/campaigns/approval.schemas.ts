import { z } from 'zod';

export const rejectCampaignSchema = z.object({
  reason: z.string().trim().min(1, 'A rejection reason is required').max(1000),
});
export type RejectCampaignInput = z.infer<typeof rejectCampaignSchema>;
