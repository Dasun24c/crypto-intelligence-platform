import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  ChangePasswordRequestSchema,
  CreateUserRequestSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  PageQuerySchema,
  pageSchema,
  ProblemSchema,
  ROLES,
  UpdateUserRequestSchema,
  can,
  mfaMandatory,
} from './index.js';

describe('RBAC matrix (architecture §14)', () => {
  // The table in the architecture document, transcribed independently of rbac.ts.
  const expected: Record<string, readonly string[]> = {
    'dashboards.view': ['viewer', 'analyst', 'admin'],
    'alerts.own': ['viewer', 'analyst', 'admin'],
    'ai.request': ['analyst', 'admin'],
    'replays.run': ['analyst', 'admin'],
    'fixtures.label': ['analyst', 'admin'],
    'instruments.manage': ['admin'],
    'settings.manage': ['admin'],
    'users.manage': ['admin'],
    'audit.view': ['admin'],
  };

  it('covers every capability', () => {
    expect([...CAPABILITIES].sort()).toEqual(Object.keys(expected).sort());
  });

  for (const capability of CAPABILITIES) {
    for (const role of ROLES) {
      const allowed = expected[capability]!.includes(role);
      it(`${role} ${allowed ? 'may' : 'may not'} ${capability}`, () => {
        expect(can(role, capability)).toBe(allowed);
      });
    }
  }

  it('makes MFA mandatory for admins only', () => {
    expect(ROLES.filter(mfaMandatory)).toEqual(['admin']);
  });
});

describe('request schemas', () => {
  it('normalises the login e-mail and rejects unknown fields', () => {
    expect(LoginRequestSchema.parse({ email: 'Ana@Example.TEST', password: 'x' })).toEqual({
      email: 'ana@example.test',
      password: 'x',
    });
    expect(LoginRequestSchema.safeParse({ email: 'a@b.test', password: 'x', admin: true }).success).toBe(
      false,
    );
  });

  it('enforces the password policy for new users', () => {
    const base = { email: 'new@example.test', displayName: 'New', role: 'viewer' };
    expect(CreateUserRequestSchema.safeParse({ ...base, password: 'short' }).success).toBe(false);
    expect(CreateUserRequestSchema.safeParse({ ...base, password: 'a long enough passphrase' }).success).toBe(
      true,
    );
  });

  it('refuses a password change to the same password', () => {
    const same = { currentPassword: 'old passphrase 1', newPassword: 'old passphrase 1' };
    expect(ChangePasswordRequestSchema.safeParse(same).success).toBe(false);
  });

  it('refuses empty user updates and admin-set lockouts', () => {
    expect(UpdateUserRequestSchema.safeParse({}).success).toBe(false);
    expect(UpdateUserRequestSchema.safeParse({ status: 'locked' }).success).toBe(false);
    expect(UpdateUserRequestSchema.safeParse({ status: 'disabled' }).success).toBe(true);
  });

  it('bounds page sizes', () => {
    expect(PageQuerySchema.parse({}).limit).toBe(100);
    expect(PageQuerySchema.safeParse({ limit: '1001' }).success).toBe(false);
  });
});

describe('response schemas', () => {
  it('builds cursor pages of any item schema', () => {
    const schema = pageSchema(ProblemSchema.pick({ code: true }));
    expect(schema.parse({ items: [{ code: 'NOT_FOUND' }], nextCursor: null }).items).toHaveLength(1);
    expect(schema.safeParse({ items: [{ code: 'NOPE' }], nextCursor: null }).success).toBe(false);
  });

  it('distinguishes MFA challenges from token responses', () => {
    const challenge = LoginResponseSchema.parse({
      mfaRequired: true,
      mfaToken: 't',
      enrollmentRequired: false,
    });
    expect('mfaRequired' in challenge).toBe(true);
  });

  it('accepts RFC 9457 problems with a known code', () => {
    const problem = { type: 'about:blank', title: 'Forbidden', status: 403, code: 'FORBIDDEN' };
    expect(ProblemSchema.parse(problem).code).toBe('FORBIDDEN');
    expect(ProblemSchema.safeParse({ ...problem, code: 'NOPE' }).success).toBe(false);
  });
});
