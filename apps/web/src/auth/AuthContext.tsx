import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  hasPermission,
  PLATFORM_TENANT_ID,
  type AccessTokenClaims,
  type Permission,
} from '@erp/contracts';
import { api, setAccessToken, setRefresher } from '../api/client';
import type { MfaChallenge, OtpChannel, OtpSent, SessionResponse, UserDto } from '../api/types';

type Status = 'loading' | 'anonymous' | 'authenticated';

interface AuthState {
  status: Status;
  user: (UserDto & { tenantId: string }) | null;
  claims: AccessTokenClaims | null;
  mfaSetupRequired: boolean;
}

interface AuthApi extends AuthState {
  isPlatform: boolean;
  can: (perm: Permission, path?: string) => boolean;
  login: (tenantSlug: string, email: string, password: string) => Promise<MfaChallenge | null>;
  loginMfa: (mfaToken: string, code: string) => Promise<void>;
  /** Password-less: a code on WhatsApp (or email) to a verified mobile number. */
  requestOtp: (tenantSlug: string, phone: string, channel: OtpChannel) => Promise<OtpSent>;
  loginOtp: (otpToken: string, code: string) => Promise<MfaChallenge | null>;
  resendMfa: (mfaToken: string, channel: OtpChannel) => Promise<OtpSent>;
  logout: () => Promise<void>;
  /** Re-reads permissions, e.g. after the user's roles change. */
  reload: () => Promise<void>;
}

const AuthContext = createContext<AuthApi | null>(null);

const LAST_COMPANY = 'erp.lastCompany';

export function rememberCompany(slug: string): void {
  try {
    localStorage.setItem(LAST_COMPANY, slug);
  } catch {
    /* storage may be unavailable */
  }
}

export function lastCompany(): string {
  try {
    return localStorage.getItem(LAST_COMPANY) ?? '';
  } catch {
    return '';
  }
}

function decodeClaims(token: string): AccessTokenClaims {
  const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as AccessTokenClaims;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    status: 'loading',
    user: null,
    claims: null,
    mfaSetupRequired: false,
  });
  const timer = useRef<number | undefined>(undefined);

  const apply = useCallback((s: SessionResponse | null) => {
    window.clearTimeout(timer.current);
    if (!s) {
      setAccessToken(null);
      setState({ status: 'anonymous', user: null, claims: null, mfaSetupRequired: false });
      return;
    }
    setAccessToken(s.accessToken);
    setState({
      status: 'authenticated',
      user: s.user,
      claims: decodeClaims(s.accessToken),
      mfaSetupRequired: s.mfaSetupRequired,
    });
    // Refresh a minute before expiry so the user never sees a 401.
    timer.current = window.setTimeout(() => void refresh(), Math.max(10, s.expiresIn - 60) * 1000);
  }, []);

  const refresh = useCallback(async (): Promise<string | null> => {
    try {
      const s = await api<SessionResponse>('/identity/auth/refresh', {
        method: 'POST',
        auth: false,
      });
      apply(s);
      return s.accessToken;
    } catch {
      apply(null);
      return null;
    }
  }, [apply]);

  useEffect(() => {
    setRefresher(refresh);
    void refresh();
    return () => window.clearTimeout(timer.current);
  }, [refresh]);

  const value = useMemo<AuthApi>(() => {
    const claims = state.claims;
    return {
      ...state,
      isPlatform: claims?.tid === PLATFORM_TENANT_ID,
      can: (perm, path) => !!claims && hasPermission(claims, perm, path),
      async login(tenantSlug, email, password) {
        const res = await api<SessionResponse | MfaChallenge>('/identity/auth/login', {
          method: 'POST',
          auth: false,
          body: { tenantSlug, email, password },
        });
        rememberCompany(tenantSlug);
        if ('mfaRequired' in res) return res;
        apply(res);
        return null;
      },
      async loginMfa(mfaToken, code) {
        apply(
          await api<SessionResponse>('/identity/auth/login/mfa', {
            method: 'POST',
            auth: false,
            body: { mfaToken, code },
          }),
        );
      },
      async requestOtp(tenantSlug, phone, channel) {
        const res = await api<OtpSent>('/identity/auth/otp/request', {
          method: 'POST',
          auth: false,
          body: { tenantSlug, phone, channel },
        });
        rememberCompany(tenantSlug);
        return res;
      },
      async loginOtp(otpToken, code) {
        const res = await api<SessionResponse | MfaChallenge>('/identity/auth/otp/verify', {
          method: 'POST',
          auth: false,
          body: { otpToken, code },
        });
        if ('mfaRequired' in res) return res;
        apply(res);
        return null;
      },
      resendMfa(mfaToken, channel) {
        return api<OtpSent>('/identity/auth/login/mfa/resend', {
          method: 'POST',
          auth: false,
          body: { mfaToken, channel },
        });
      },
      async logout() {
        await api('/identity/auth/logout', { method: 'POST', auth: false }).catch(() => undefined);
        apply(null);
      },
      async reload() {
        await refresh();
      },
    };
  }, [state, apply, refresh]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthApi {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
