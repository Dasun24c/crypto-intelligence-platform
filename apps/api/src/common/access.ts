import { SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Capability, Role } from '@cip/contracts';

/**
 * Access policy of a route (architecture §14: role-based, default deny).
 * - `public`: no token needed (login, refresh, probes);
 * - `authenticated`: any signed-in, active user (their own profile);
 * - a capability from the RBAC matrix.
 * A route without a policy is refused for everyone, so a forgotten decorator fails closed.
 */
export type AccessPolicy = 'public' | 'authenticated' | Capability;

export const ACCESS_KEY = 'cip:access';
export const Access = (policy: AccessPolicy) => SetMetadata(ACCESS_KEY, policy);

export interface AuthenticatedUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
}

export interface ApiRequest extends Request {
  correlationId?: string;
  user?: AuthenticatedUser;
  cookies: Record<string, string | undefined>;
}

/** Client IP as resolved by Express behind the configured proxies. */
export function clientIp(req: Request): string | null {
  const ip = req.ip ?? req.socket.remoteAddress ?? null;
  return ip && ip.length <= 64 ? ip : null;
}

export function userAgent(req: Request): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 512) : null;
}
