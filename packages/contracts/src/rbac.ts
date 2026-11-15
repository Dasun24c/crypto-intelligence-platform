import { z } from 'zod';

export const ROLES = ['admin', 'analyst', 'viewer'] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;

/**
 * Capabilities from the RBAC matrix (architecture §14). The default is deny:
 * a capability not listed for a role is refused.
 */
export const CAPABILITIES = [
  'dashboards.view', // dashboards, charts, setups, AI history, system health
  'alerts.own', // personal alert rules and notifications
  'ai.request', // on-demand AI analysis (budgeted)
  'replays.run', // run replays
  'fixtures.label', // label SMC fixtures
  'instruments.manage', // instruments, profiles
  'settings.manage', // AI budget, thresholds, closures, calendar entries
  'users.manage', // user administration
  'audit.view', // audit log
] as const;
export const CapabilitySchema = z.enum(CAPABILITIES);
export type Capability = z.infer<typeof CapabilitySchema>;

export const ROLE_CAPABILITIES: Readonly<Record<Role, readonly Capability[]>> = {
  viewer: ['dashboards.view', 'alerts.own'],
  analyst: ['dashboards.view', 'alerts.own', 'ai.request', 'replays.run', 'fixtures.label'],
  admin: [
    'dashboards.view',
    'alerts.own',
    'ai.request',
    'replays.run',
    'fixtures.label',
    'instruments.manage',
    'settings.manage',
    'users.manage',
    'audit.view',
  ],
};

export function can(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(capability);
}

/** Roles that must use a second factor to sign in (architecture §14: TOTP is mandatory for admins). */
export function mfaMandatory(role: Role): boolean {
  return role === 'admin';
}
