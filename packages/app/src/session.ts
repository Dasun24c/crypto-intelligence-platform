import { createContext, useContext, useEffect, useState } from 'react';
import { create } from 'zustand';
import type {
  LoginResponse,
  MeResponse,
  MfaSecretResponse,
  TokenResponse,
  UserSummary,
} from '@cip/contracts';
import { ApiClient } from './api/client.js';
import { LiveClient, type SocketFactory } from './live/live-client.js';
import type { Platform } from './platform.js';

export type SessionState =
  | { status: 'loading' }
  | { status: 'needs-server' }
  | { status: 'signed-out'; notice?: string }
  | {
      status: 'mfa';
      mfaToken: string;
      enrollmentRequired: boolean;
      enrollment: MfaSecretResponse | null;
    }
  | { status: 'signed-in'; user: UserSummary; me: MeResponse };

export interface SessionOptions {
  /** Replaces the Socket.IO transport (tests). */
  createSocket?: SocketFactory;
}

const SESSION_ENDED = 'Your session ended. Sign in again.';

/**
 * Owns the sign-in state machine: loading → (needs-server) → signed-out → (mfa) → signed-in.
 * Pages call these actions; the store is the single source of truth for who is signed in.
 */
export class Session {
  readonly client: ApiClient;
  /** The live connection shared by every widget of the signed-in session. */
  readonly live: LiveClient;
  readonly store = create<{ state: SessionState }>(() => ({ state: { status: 'loading' } }));

  constructor(
    readonly platform: Platform,
    options: SessionOptions = {},
  ) {
    this.client = new ApiClient(platform, () => this.set({ status: 'signed-out', notice: SESSION_ENDED }));
    this.live = new LiveClient({
      getServerUrl: () => platform.getServerUrl(),
      getToken: () => this.client.token,
      refreshToken: () => this.client.refresh(),
      onSessionEnded: () => {
        this.client.clear();
        this.set({ status: 'signed-out', notice: SESSION_ENDED });
      },
      ...(options.createSocket ? { createSocket: options.createSocket } : {}),
    });
  }

  private set(state: SessionState): void {
    this.store.setState({ state });
    // Nothing live outlives the session.
    if (state.status !== 'signed-in') this.live.stop();
  }

  get state(): SessionState {
    return this.store.getState().state;
  }

  /** Start-up: desktop needs a server first; then an existing session is resumed if possible. */
  async bootstrap(): Promise<void> {
    if (this.platform.kind === 'desktop' && !(await this.platform.getServerUrl())) {
      this.set({ status: 'needs-server' });
      return;
    }
    try {
      if (await this.client.refresh()) {
        await this.loadMe();
        return;
      }
    } catch {
      // server unreachable or refused: fall through to the sign-in page
    }
    this.set({ status: 'signed-out' });
  }

  async chooseServer(url: string): Promise<void> {
    if (!this.platform.setServerUrl) return;
    await this.platform.setServerUrl(url);
    await this.bootstrap();
  }

  private async loadMe(): Promise<void> {
    const me = await this.client.request<MeResponse>('GET', '/api/v1/me');
    this.set({ status: 'signed-in', user: me.user, me });
  }

  private async accept(tokens: TokenResponse): Promise<void> {
    await this.client.acceptSession(tokens);
    await this.loadMe();
  }

  async login(email: string, password: string): Promise<void> {
    const res = await this.client.auth<LoginResponse>('/api/v1/auth/login', { email, password });
    if ('mfaRequired' in res) {
      this.set({
        status: 'mfa',
        mfaToken: res.mfaToken,
        enrollmentRequired: res.enrollmentRequired,
        enrollment: null,
      });
      return;
    }
    await this.accept(res);
  }

  async startEnrollment(): Promise<void> {
    const s = this.state;
    if (s.status !== 'mfa') return;
    const enrollment = await this.client.auth<MfaSecretResponse>('/api/v1/auth/mfa/enroll', {
      mfaToken: s.mfaToken,
    });
    this.set({ ...s, enrollment });
  }

  async verifyMfa(code: string): Promise<void> {
    const s = this.state;
    if (s.status !== 'mfa') return;
    await this.accept(
      await this.client.auth<TokenResponse>('/api/v1/auth/mfa', { mfaToken: s.mfaToken, code }),
    );
  }

  cancelMfa(): void {
    this.set({ status: 'signed-out' });
  }

  async reloadMe(): Promise<void> {
    await this.loadMe();
  }

  async logout(notice?: string): Promise<void> {
    await this.client.logout().catch(() => undefined);
    this.set(notice ? { status: 'signed-out', notice } : { status: 'signed-out' });
  }
}

export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionContext');
  return session;
}

export function useSessionState(): SessionState {
  return useSession().store((s) => s.state);
}

/** The signed-in user. Only used inside the signed-in part of the app. */
export function useCurrentUser(): UserSummary {
  const state = useSessionState();
  if (state.status !== 'signed-in') throw new Error('useCurrentUser while not signed in');
  return state.user;
}

/** The signed-in user's display time zone (preferences), UTC otherwise. */
export function useDisplayTimeZone(): string {
  const state = useSessionState();
  return state.status === 'signed-in' ? state.me.preferences.displayTimeZone : 'UTC';
}

/** Current time, updated every `intervalMs`, so ages ("5 s ago") stay correct without impure renders. */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
