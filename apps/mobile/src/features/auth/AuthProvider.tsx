import {
  AuthSessionSchema,
  type LoginInput,
  type Me,
  MeSchema,
  NoContentSchema,
  type RegisterInput,
  type UpdateMeInput,
} from '@sussurro/shared';
import { useToast } from '@sussurro/ui';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import type { ApiClient } from '../../lib/api/client';
import { isApiError } from '../../lib/api/errors';
import { deviceLabel } from '../../lib/device';
import type { SessionStore } from '../../lib/session/secure-session-store';

/**
 * - `loading`: lendo a sessão guardada na abertura do app;
 * - `signedOut`: sem sessão (Entrar/Cadastro);
 * - `signedIn`: com o perfil carregado;
 * - `unavailable`: havia sessão, mas o servidor não respondeu (sem internet na abertura).
 */
export type AuthStatus = 'loading' | 'signedOut' | 'signedIn' | 'unavailable';

interface AuthState {
  status: AuthStatus;
  user: Me | null;
}

export interface AuthContextValue extends AuthState {
  api: ApiClient;
  /** Último e-mail usado em Entrar, para preencher de novo (ux.md §5.4). */
  lastEmail: string | null;
  signIn: (input: Omit<LoginInput, 'deviceLabel'>) => Promise<void>;
  signUp: (input: Omit<RegisterInput, 'deviceLabel'>) => Promise<void>;
  /** Sai deste aparelho (sempre limpa a sessão local) ou de todos (falha se a API não responder). */
  signOut: (options?: { everywhere?: boolean }) => Promise<void>;
  deleteAccount: (password: string) => Promise<void>;
  updateProfile: (input: UpdateMeInput) => Promise<Me>;
  reloadUser: () => Promise<Me>;
  /**
   * Muda o usuário em memória sem chamar a API (ex.: o número de criadores sobe na hora ao seguir,
   * história 3.3 CA1). O `reloadUser` depois acerta com o servidor.
   */
  patchUser: (change: (user: Me) => Me) => void;
  resendVerification: () => Promise<void>;
  /** Esquece a sessão local (ex.: depois de redefinir a senha, que revoga todas as sessões). */
  endLocalSession: () => Promise<void>;
  /** Tenta de novo restaurar a sessão depois de `unavailable`. */
  retry: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export interface AuthProviderProps {
  api: ApiClient;
  store: SessionStore;
  children: ReactNode;
}

export const SESSION_EXPIRED_MESSAGE = 'Sua sessão expirou. Entre de novo.';
export const ACCOUNT_DELETED_MESSAGE = 'Sua conta foi excluída.';

export function AuthProvider({ api, store, children }: AuthProviderProps) {
  const toast = useToast();
  const [state, setState] = useState<AuthState>({ status: 'loading', user: null });
  const [lastEmail, setLastEmail] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // Abertura do app: refresh guardado → par novo → GET /me.
  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      setState({ status: 'loading', user: null });
      setLastEmail(await store.getLastEmail());
      try {
        const restored = await api.restoreSession();
        if (!restored) {
          if (!cancelled) setState({ status: 'signedOut', user: null });
          return;
        }
        const user = await api.request('/v1/me', { schema: MeSchema });
        if (!cancelled) setState({ status: 'signedIn', user });
      } catch (error) {
        if (cancelled) return;
        if (isApiError(error) && error.status === 401) {
          await api.clearSession();
          setState({ status: 'signedOut', user: null });
          return;
        }
        setState({ status: 'unavailable', user: null });
      }
    };
    void restore();
    return () => {
      cancelled = true;
    };
  }, [api, store, attempt]);

  // Refresh recusado no meio do uso: volta para Entrar com o aviso (AUTH-10, ux.md §5.4).
  useEffect(() => {
    api.onSessionExpired(() => {
      setState({ status: 'signedOut', user: null });
      toast.show({ message: SESSION_EXPIRED_MESSAGE, variant: 'error' });
    });
    return () => {
      api.onSessionExpired(null);
    };
  }, [api, toast]);

  const rememberEmail = useCallback(
    async (email: string) => {
      const normalized = email.trim().toLowerCase();
      setLastEmail(normalized);
      await store.setLastEmail(normalized);
    },
    [store],
  );

  const signIn = useCallback<AuthContextValue['signIn']>(
    async (input) => {
      await rememberEmail(input.email);
      const session = await api.request('/v1/auth/login', {
        method: 'POST',
        body: { ...input, deviceLabel: deviceLabel() },
        schema: AuthSessionSchema,
        auth: false,
      });
      await api.setSession(session.tokens);
      setState({ status: 'signedIn', user: session.user });
    },
    [api, rememberEmail],
  );

  const signUp = useCallback<AuthContextValue['signUp']>(
    async (input) => {
      const session = await api.request('/v1/auth/register', {
        method: 'POST',
        body: { ...input, deviceLabel: deviceLabel() },
        schema: AuthSessionSchema,
        auth: false,
      });
      await rememberEmail(input.email);
      await api.setSession(session.tokens);
      setState({ status: 'signedIn', user: session.user });
    },
    [api, rememberEmail],
  );

  const endLocalSession = useCallback(async () => {
    await api.clearSession();
    setState({ status: 'signedOut', user: null });
  }, [api]);

  const signOut = useCallback<AuthContextValue['signOut']>(
    async (options = {}) => {
      if (options.everywhere === true) {
        await api.request('/v1/auth/logout-all', { method: 'POST', schema: NoContentSchema });
      } else {
        // Sem rede, a sessão deste aparelho sai do mesmo jeito (o refresh vence sozinho).
        await api
          .request('/v1/auth/logout', { method: 'POST', schema: NoContentSchema })
          .catch(() => undefined);
      }
      await endLocalSession();
    },
    [api, endLocalSession],
  );

  const deleteAccount = useCallback<AuthContextValue['deleteAccount']>(
    async (password) => {
      await api.request('/v1/me', {
        method: 'DELETE',
        body: { password },
        schema: NoContentSchema,
      });
      await endLocalSession();
      toast.show({ message: ACCOUNT_DELETED_MESSAGE, variant: 'success' });
    },
    [api, endLocalSession, toast],
  );

  const reloadUser = useCallback(async () => {
    const user = await api.request('/v1/me', { schema: MeSchema });
    setState({ status: 'signedIn', user });
    return user;
  }, [api]);

  const patchUser = useCallback<AuthContextValue['patchUser']>((change) => {
    setState((current) =>
      current.user === null ? current : { ...current, user: change(current.user) },
    );
  }, []);

  const updateProfile = useCallback<AuthContextValue['updateProfile']>(
    async (input) => {
      const user = await api.request('/v1/me', {
        method: 'PATCH',
        body: input,
        schema: MeSchema,
      });
      setState({ status: 'signedIn', user });
      return user;
    },
    [api],
  );

  const resendVerification = useCallback(async () => {
    await api.request('/v1/me/email/verification', { method: 'POST', schema: NoContentSchema });
  }, [api]);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      api,
      lastEmail,
      signIn,
      signUp,
      signOut,
      deleteAccount,
      updateProfile,
      reloadUser,
      patchUser,
      resendVerification,
      endLocalSession,
      retry,
    }),
    [
      state,
      api,
      lastEmail,
      signIn,
      signUp,
      signOut,
      deleteAccount,
      updateProfile,
      reloadUser,
      patchUser,
      resendVerification,
      endLocalSession,
      retry,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (context === null) {
    throw new Error('useAuth precisa de um <AuthProvider> acima na árvore.');
  }
  return context;
}

/** O usuário logado; só para telas que estão atrás do portão de sessão. */
export function useSignedInUser(): Me {
  const { user } = useAuth();
  if (user === null) {
    throw new Error('Tela de conta logada aberta sem sessão.');
  }
  return user;
}
