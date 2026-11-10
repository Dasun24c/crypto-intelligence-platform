import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import {
  CLIENT_HEADER,
  type LoginRequest,
  LoginRequestSchema,
  type LoginResponse,
  type MfaEnrollRequest,
  MfaEnrollRequestSchema,
  type MfaSecretResponse,
  type MfaVerifyRequest,
  MfaVerifyRequestSchema,
  REFRESH_COOKIE,
  type RefreshRequest,
  RefreshRequestSchema,
  type TokenResponse,
} from '@cip/contracts';
import { Access, type ApiRequest, clientIp, userAgent } from '../common/access.js';
import { ProblemError } from '../common/problem.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { API_CONFIG } from '../tokens.js';
import { TAURI_ORIGINS, type ApiConfig } from '../config.js';
import { AuthService, type ClientKind, type IssuedSession, type RequestContext } from './auth.service.js';
import { REFRESH_TOKEN_TTL_MS } from './refresh-tokens.service.js';

export const AUTH_COOKIE_PATH = '/api/v1/auth';

@Controller('auth')
@Access('public')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  private context(req: ApiRequest): RequestContext {
    const client: ClientKind = req.headers[CLIENT_HEADER] === 'desktop' ? 'desktop' : 'web';
    return { ip: clientIp(req), userAgent: userAgent(req), client };
  }

  /** Web: refresh token in an httpOnly SameSite=Strict cookie. Desktop: in the body (OS keychain). */
  private deliver(session: IssuedSession, res: Response): TokenResponse {
    if (session.client === 'desktop') return { ...session.response, refreshToken: session.refreshToken };
    res.cookie(REFRESH_COOKIE, session.refreshToken, {
      httpOnly: true,
      secure: this.config.COOKIE_SECURE,
      sameSite: 'strict',
      path: AUTH_COOKIE_PATH,
      maxAge: REFRESH_TOKEN_TTL_MS,
    });
    return session.response;
  }

  /** Cookie-authenticated calls must come from an allowed origin (defence in depth over SameSite). */
  private checkOrigin(req: ApiRequest): void {
    const origin = req.headers.origin;
    if (origin && ![...this.config.CORS_ORIGINS, ...TAURI_ORIGINS].includes(origin)) {
      throw new ProblemError('FORBIDDEN', 'Origin not allowed.');
    }
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(LoginRequestSchema)) body: LoginRequest,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponse> {
    const result = await this.auth.login(body, this.context(req));
    return 'mfaRequired' in result ? result : this.deliver(result, res);
  }

  @Post('mfa/enroll')
  @HttpCode(200)
  enroll(
    @Body(new ZodPipe(MfaEnrollRequestSchema)) body: MfaEnrollRequest,
    @Req() req: ApiRequest,
  ): Promise<MfaSecretResponse> {
    return this.auth.enrollDuringLogin(body.mfaToken, this.context(req));
  }

  @Post('mfa')
  @HttpCode(200)
  async mfa(
    @Body(new ZodPipe(MfaVerifyRequestSchema)) body: MfaVerifyRequest,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponse> {
    return this.deliver(await this.auth.verifyMfa(body.mfaToken, body.code, this.context(req)), res);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body(new ZodPipe(RefreshRequestSchema)) body: RefreshRequest,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponse> {
    const presented = body.refreshToken ?? req.cookies[REFRESH_COOKIE];
    if (!body.refreshToken) this.checkOrigin(req);
    if (!presented) throw new ProblemError('AUTH_REQUIRED', 'No session.');
    try {
      return this.deliver(await this.auth.refresh(presented, this.context(req)), res);
    } catch (err) {
      if (!body.refreshToken) res.clearCookie(REFRESH_COOKIE, { path: AUTH_COOKIE_PATH });
      throw err;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(
    @Body(new ZodPipe(RefreshRequestSchema)) body: RefreshRequest,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (!body.refreshToken) this.checkOrigin(req);
    await this.auth.logout(body.refreshToken ?? req.cookies[REFRESH_COOKIE], this.context(req));
    res.clearCookie(REFRESH_COOKIE, { path: AUTH_COOKIE_PATH });
  }
}
