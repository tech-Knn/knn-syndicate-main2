import { z } from 'zod';

export const createOrgSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9-]+$/, 'slug may contain lowercase letters, numbers, and hyphens'),
  adminName: z.string().trim().min(1).max(120),
  adminEmail: z.string().trim().toLowerCase().email(),
  adminPassword: z.string().min(8).max(200),
});
export type CreateOrgInput = z.infer<typeof createOrgSchema>;

export const userActionSchema = z.object({
  action: z.enum(['approve', 'reject', 'suspend', 'reactivate']),
});
export type UserAction = z.infer<typeof userActionSchema>['action'];

export const autoApproveSchema = z.object({
  autoApprove: z.boolean(),
});
export type AutoApproveInput = z.infer<typeof autoApproveSchema>;

export const autoLaunchSchema = z.object({
  autoLaunch: z.boolean(),
});
export type AutoLaunchInput = z.infer<typeof autoLaunchSchema>;
