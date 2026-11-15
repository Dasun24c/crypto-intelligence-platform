import { createPrivateKey, createPublicKey, type KeyObject, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { calculateJwkThumbprint, errors, exportJWK, jwtVerify, type JWTPayload, SignJWT } from 'jose';
import { RoleSchema, type Role } from '@cip/contracts';
import type { ApiConfig } from '../config.js';
import { ProblemError } from '../common/problem.js';
import { API_CONFIG, CLOCK, type Clock } from '../tokens.js';

const ALG = 'EdDSA';
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const MFA_TOKEN_TTL_SECONDS = 5 * 60;
const ACCESS_AUDIENCE = 'cip-api';
const MFA_AUDIENCE = 'cip-mfa';

export interface AccessClaims {
  userId: string;
  role: Role;
  /** Epoch seconds (JWT `iat`). */
  issuedAt: number;
  /** Epoch ms (JWT `exp`): live connections are asked to renew before it. */
  expiresAt: number;
}

export interface MfaClaims {
  userId: string;
  jti: string;
  client: 'web' | 'desktop';
  enroll: boolean;
  expiresAt: number;
}

interface VerificationKey {
  kid: string;
  key: KeyObject;
}

/**
 * Signs and verifies JWTs with Ed25519 (architecture §14). Access tokens live 15 minutes; MFA
 * tokens (proof that the password step succeeded) live 5 minutes and have their own audience, so
 * one can never be used as the other. Retired public keys stay accepted for verification only.
 */
@Injectable()
export class TokenService {
  private readonly signingKey: KeyObject;
  private readonly keys: Promise<{ current: VerificationKey; all: Map<string, KeyObject> }>;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.signingKey = createPrivateKey(config.AUTH_JWT_PRIVATE_KEY);
    if (this.signingKey.asymmetricKeyType !== 'ed25519')
      throw new Error('AUTH_JWT_PRIVATE_KEY must be an Ed25519 key');
    this.keys = this.loadKeys();
  }

  private async loadKeys() {
    const all = new Map<string, KeyObject>();
    const kidOf = async (key: KeyObject) => calculateJwkThumbprint(await exportJWK(key));
    const currentPublic = createPublicKey(this.signingKey);
    const current = { kid: await kidOf(currentPublic), key: currentPublic };
    all.set(current.kid, currentPublic);
    const pems = this.config.AUTH_JWT_PREVIOUS_PUBLIC_KEYS?.match(
      /-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/g,
    );
    for (const pem of pems ?? []) {
      const key = createPublicKey(pem);
      all.set(await kidOf(key), key);
    }
    return { current, all };
  }

  private nowSeconds(): number {
    return Math.floor(this.clock() / 1000);
  }

  async issueAccessToken(
    claims: Omit<AccessClaims, 'issuedAt' | 'expiresAt'>,
  ): Promise<{ token: string; expiresAt: number }> {
    const { current } = await this.keys;
    const iat = this.nowSeconds();
    const exp = iat + ACCESS_TOKEN_TTL_SECONDS;
    const token = await new SignJWT({ role: claims.role })
      .setProtectedHeader({ alg: ALG, kid: current.kid, typ: 'at+jwt' })
      .setIssuer(this.config.AUTH_ISSUER)
      .setAudience(ACCESS_AUDIENCE)
      .setSubject(claims.userId)
      .setJti(randomUUID())
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.signingKey);
    return { token, expiresAt: exp * 1000 };
  }

  async verifyAccessToken(token: string): Promise<AccessClaims> {
    const payload = await this.verify(token, ACCESS_AUDIENCE, 'at+jwt');
    const role = RoleSchema.safeParse(payload['role']);
    if (!payload.sub || !role.success || payload.iat === undefined || payload.exp === undefined)
      throw new ProblemError('AUTH_REQUIRED');
    return { userId: payload.sub, role: role.data, issuedAt: payload.iat, expiresAt: payload.exp * 1000 };
  }

  async issueMfaToken(userId: string, client: 'web' | 'desktop', enroll: boolean): Promise<string> {
    const { current } = await this.keys;
    const iat = this.nowSeconds();
    return new SignJWT({ client, enroll })
      .setProtectedHeader({ alg: ALG, kid: current.kid, typ: 'mfa+jwt' })
      .setIssuer(this.config.AUTH_ISSUER)
      .setAudience(MFA_AUDIENCE)
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuedAt(iat)
      .setExpirationTime(iat + MFA_TOKEN_TTL_SECONDS)
      .sign(this.signingKey);
  }

  async verifyMfaToken(token: string): Promise<MfaClaims> {
    const payload = await this.verify(token, MFA_AUDIENCE, 'mfa+jwt');
    const client = payload['client'];
    if (!payload.sub || !payload.jti || !payload.exp || (client !== 'web' && client !== 'desktop')) {
      throw new ProblemError('AUTH_REQUIRED');
    }
    return {
      userId: payload.sub,
      jti: payload.jti,
      client,
      enroll: payload['enroll'] === true,
      expiresAt: payload.exp * 1000,
    };
  }

  private async verify(token: string, audience: string, typ: string): Promise<JWTPayload> {
    const { all } = await this.keys;
    try {
      const { payload } = await jwtVerify(
        token,
        (header) => {
          const key = header.kid ? all.get(header.kid) : undefined;
          if (!key) throw new errors.JWKSNoMatchingKey();
          return key;
        },
        {
          algorithms: [ALG],
          issuer: this.config.AUTH_ISSUER,
          audience,
          typ,
          currentDate: new Date(this.clock()),
        },
      );
      return payload;
    } catch (err) {
      if (err instanceof errors.JWTExpired) throw new ProblemError('AUTH_EXPIRED');
      throw new ProblemError('AUTH_REQUIRED');
    }
  }
}
