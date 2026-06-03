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

/** Add an (active) user to an existing company — super-admin only. */
export const addOrgUserSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(200),
  role: z.enum(['COMPANY_ADMIN', 'MEDIA_BUYER']).default('COMPANY_ADMIN'),
});
export type AddOrgUserInput = z.infer<typeof addOrgUserSchema>;

export const autoApproveSchema = z.object({
  autoApprove: z.boolean(),
});
export type AutoApproveInput = z.infer<typeof autoApproveSchema>;

export const autoLaunchSchema = z.object({
  autoLaunch: z.boolean(),
});
export type AutoLaunchInput = z.infer<typeof autoLaunchSchema>;

export const platformSettingsSchema = z
  .object({
    compliancePrompt: z.string().max(8000),
    articleDomain: z.string().trim().max(255),
    redirectDomain: z.string().trim().max(255),
  })
  .partial();
export type PlatformSettingsInput = z.infer<typeof platformSettingsSchema>;

export const revenueCutSchema = z.object({
  pct: z.number().min(0).max(1),
});
export type RevenueCutInput = z.infer<typeof revenueCutSchema>;

const funnelModeEnum = z.enum(['NORMAL', 'CLOAKER']);

/** Super-admin: enable cloaking for a company and/or set its default funnel mode. */
export const cloakingSchema = z
  .object({ cloakingEnabled: z.boolean(), defaultFunnelMode: funnelModeEnum })
  .partial()
  .refine((v) => v.cloakingEnabled !== undefined || v.defaultFunnelMode !== undefined, {
    message: 'Provide cloakingEnabled and/or defaultFunnelMode',
  });
export type CloakingInput = z.infer<typeof cloakingSchema>;

/** Per-buyer funnel-mode override (null = inherit the org default). */
export const funnelModeSchema = z.object({ funnelMode: funnelModeEnum.nullable() });
export type FunnelModeInput = z.infer<typeof funnelModeSchema>;

export const redirectDomainCreateSchema = z.object({
  host: z.string().trim().min(1).max(255),
  label: z.string().trim().max(120).optional(),
  mode: funnelModeEnum.optional(),
  ownerOrgId: z.string().uuid().nullable().optional(),
  /** false = add the host but hold it OUT of rotation (parked / "not in use" until assigned). */
  isActive: z.boolean().optional(),
});
export type RedirectDomainCreateInput = z.infer<typeof redirectDomainCreateSchema>;

export const redirectDomainUpdateSchema = z
  .object({
    label: z.string().trim().max(120).nullable(),
    mode: funnelModeEnum,
    ownerOrgId: z.string().uuid().nullable(),
    isActive: z.boolean(),
  })
  .partial();
export type RedirectDomainUpdateInput = z.infer<typeof redirectDomainUpdateSchema>;

export const whiteDomainCreateSchema = z.object({
  host: z.string().trim().min(1).max(255),
  label: z.string().trim().max(120).optional(),
});
export type WhiteDomainCreateInput = z.infer<typeof whiteDomainCreateSchema>;

export const whiteDomainUpdateSchema = z
  .object({ label: z.string().trim().max(120).nullable(), isActive: z.boolean() })
  .partial();
export type WhiteDomainUpdateInput = z.infer<typeof whiteDomainUpdateSchema>;
