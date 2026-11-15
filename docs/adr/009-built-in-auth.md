# ADR 009: Built-in authentication (argon2id, TOTP, rotating refresh tokens)

| | |
|---|---|
| Status | Accepted |
| Date | 2026-11-10 |
| Deciders | Project owner (Phase 0 approval) |
| Related | [Architecture §14 Security](../phase-0/03-architecture.md#14-security) · [API contracts §2 Authentication](../phase-0/06-api-contracts.md#2-authentication) · [README decision D1](../phase-0/README.md#decisions-needed) · [Risks R26](../phase-0/04-risks-and-dependencies.md#1-risk-register) · [ADR 008](008-desktop-thin-tauri-client.md) |

## Context

Decision D1 fixes the deployment model: self-hosted by one organisation, up to about 50 named users, with roles admin, analyst and viewer. The platform holds no exchange secrets, but it does hold a paid AI budget, user alert rules and an audit log. Stolen credentials and token leakage are named risks (R26). Web and desktop clients must both be supported (ADR 008).

## Decision

Build authentication into the `api` service:

- **Passwords**: local accounts with argon2id hashes. Login is rate-limited with progressive lockout.
- **MFA**: TOTP, mandatory for admins.
- **Access tokens**: JWT, 15 minutes, EdDSA signing keys that are rotated.
- **Refresh tokens**: opaque, stored hashed, rotated on use with reuse detection, valid for 14 days. Logout revokes the whole token family.
- **Storage on the client**: the web app keeps the refresh token in an httpOnly, Secure, SameSite=Strict cookie. The desktop app keeps it in the OS keychain and sends `X-Client: desktop` to receive it in the response body.
- **Authorization**: role-based, enforced on every route and channel, default deny.
- **Audit**: logins, MFA changes, user and role changes and other sensitive actions go to an append-only log with a SHA-256 hash chain computed by a database trigger.

OIDC single sign-on can be added later (architecture §14).

## Consequences

**Positive**

- No dependency on an external identity provider to run the platform. Compose on one VM is enough (principle 7).
- The same token model serves web and desktop, with storage that fits each platform.
- Refresh-token reuse detection limits the damage of a stolen token.

**Negative and costs**

- We own password handling, MFA enrolment, lockout and recovery flows, and their security reviews.
- No single sign-on at launch. Organisations that want it must wait for the later OIDC work.
- EdDSA key rotation and refresh-token families add state and operational steps.

**What we must do because of it**

- Perform the ASVS Level 2 review named in R26.
- Test token rotation, reuse detection and lockout. Test that the application database role cannot update or delete audit rows.
- Validate secrets with zod at startup and redact them from logs (architecture §14).
- Keep the auth module behind an interface, so an OIDC provider can be added without touching the routes.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **External OIDC provider** | Better for single sign-on, but it is an extra dependency for a self-hosted platform with up to about 50 users (architecture §20). It remains a later addition. |
| Long-lived bearer tokens | The Phase 0 documents do not evaluate this. The design uses short-lived access tokens and rotating refresh tokens so that a leaked token expires quickly. |
