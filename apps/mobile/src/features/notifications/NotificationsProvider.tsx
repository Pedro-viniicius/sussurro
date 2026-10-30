import { type AccountType, ExpoPushTokenSchema } from '@sussurro/shared';
import { useToast } from '@sussurro/ui';
import { router, usePathname } from 'expo-router';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Alert, AppState } from 'react-native';

import { fetchUnreadCount, registerPushToken, removePushToken } from './api';
import { pushRouteFor } from './push-route';
import type { PushPorts, PushResponse } from '../../lib/push/ports';
import { usePushPorts } from '../../lib/push/PushProvider';
import { sleep, timing } from '../../lib/timing';
import { useAuth } from '../auth/AuthProvider';
import { isPublished, usePostStore } from '../posts/post-store';

/** Pedido contextual (ux.md §4.12, 6.4 CA1). */
export const PUSH_PROMPT_TITLE = 'Quer saber quando alguém curtir ou comentar?';
export const PUSH_PROMPT_ENABLE = 'Ativar';
export const PUSH_PROMPT_LATER = 'Agora não';
export const PUSH_ENABLE_FAILED =
  'Não foi possível ativar as notificações agora. Tente de novo em Conta.';

export function pushPromptMessage(accountType: AccountType): string {
  return accountType === 'creator'
    ? 'Avisamos neste celular quando alguém curtir ou comentar e quando chegarem novos seguidores. Dá para desligar em Conta.'
    : 'Avisamos neste celular quando alguém curtir, comentar ou se conectar com você. Dá para desligar em Conta.';
}

/**
 * Notificações no celular, como aparecem em Conta: `unsupported` (sem push neste aparelho),
 * `loading`, `on` (ativadas e com permissão do sistema) e `off`.
 */
export type PushSetting = 'unsupported' | 'loading' | 'on' | 'off';

/**
 * Resultado de ativar: `on`; `denied` (a pessoa negou no pedido do sistema agora); `blocked` (o
 * sistema não pergunta mais: só nos Ajustes); `failed` (sem token ou sem rede).
 */
export type EnablePushResult = 'on' | 'denied' | 'blocked' | 'failed';

export interface NotificationsContextValue {
  /** Não lidas (até 99): o ponto azul do coração (6.2). */
  unreadCount: number;
  /** Muda a cada push recebido com o app aberto: a lista aberta recarrega. */
  pushTick: number;
  refreshUnread: () => void;
  /** O que sobrou depois do `POST /notifications/read`. */
  setUnreadCount: (count: number) => void;
  /** Pedido contextual depois da primeira conexão ou do primeiro post; uma vez só (6.4 CA4). */
  offerPush: () => void;
  pushSetting: PushSetting;
  enablePush: () => Promise<EnablePushResult>;
  /** Desliga neste aparelho: `DELETE /me/push-tokens` (falha sem rede, e nada muda). */
  disablePush: () => Promise<void>;
  openPushSettings: () => void;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

/** Token válido do `expo-notifications` (o mesmo formato que a API aceita). */
async function deviceToken(ports: PushPorts): Promise<string> {
  const token = await ports.getToken();
  if (!ExpoPushTokenSchema.safeParse(token).success) {
    throw new Error('Token de push em formato inesperado.');
  }
  return token;
}

/**
 * Notificações da conta logada (Fase 6): o número de não lidas (6.2), o push do aparelho (6.4) e
 * os toques nos pushes (6.5 CA5, 6.6).
 * - O token é registrado a cada abertura com sessão, se a pessoa ativou e o sistema permite.
 * - No logout o servidor já apaga o token daquela sessão (AUTH-12): o app não chama o `DELETE`,
 *   que fica para o "desligar" em Conta.
 * - O `data` do push passa pelo `PushDataSchema` antes de navegar (`pushRouteFor`).
 */
export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { api, status, user } = useAuth();
  const ports = usePushPorts();
  const store = usePostStore();
  const toast = useToast();
  const userId = user?.id ?? null;
  const accountType = user?.accountType ?? null;
  const supported = ports.platform !== null;
  const pathname = usePathname();

  // O número e o estado do push valem para a conta que os pediu: trocar de conta (ou sair) volta a
  // zero e a "carregando" sem precisar limpar nada.
  const [unread, setUnread] = useState<{ owner: string | null; count: number }>({
    owner: null,
    count: 0,
  });
  const unreadCount = unread.owner !== null && unread.owner === userId ? unread.count : 0;
  const [pushState, setPushState] = useState<{ owner: string | null; setting: PushSetting }>({
    owner: null,
    setting: 'loading',
  });
  const pushSetting: PushSetting = !supported
    ? 'unsupported'
    : pushState.owner !== null && pushState.owner === userId
      ? pushState.setting
      : 'loading';
  const [pushTick, setPushTick] = useState(0);
  const [responseVersion, setResponseVersion] = useState(0);

  const setUnreadCount = useCallback(
    (count: number) => {
      setUnread({ owner: userId, count });
    },
    [userId],
  );
  const setPushSetting = useCallback((owner: string, setting: PushSetting) => {
    setPushState({ owner, setting });
  }, []);

  /** A conta atual, para descartar respostas que chegam depois de trocar de conta. */
  const currentUser = useRef<string | null>(userId);
  useEffect(() => {
    currentUser.current = userId;
  });
  /** Token já registrado nesta abertura (o `PUT` tem limite de 30/h). */
  const registered = useRef<string | null>(null);
  const prompting = useRef(false);
  const pendingResponse = useRef<PushResponse | null>(null);
  const handledResponses = useRef(new Set<string>());

  const refreshUnread = useCallback(() => {
    if (userId === null) return;
    fetchUnreadCount(api)
      .then(({ count }) => {
        if (currentUser.current === userId) setUnread({ owner: userId, count });
      })
      .catch(() => undefined);
  }, [api, userId]);

  const register = useCallback(
    async (owner: string, platform: NonNullable<PushPorts['platform']>) => {
      const token = await deviceToken(ports);
      await registerPushToken(api, token, platform);
      await ports.saveState(owner, { choice: 'on', token });
      if (currentUser.current === owner) registered.current = owner;
    },
    [api, ports],
  );

  /** Abertura com sessão (e volta dos Ajustes): registra o token se a pessoa ativou. */
  const syncPush = useCallback(
    async (owner: string) => {
      const platform = ports.platform;
      if (platform === null) return;
      const [state, permission] = await Promise.all([
        ports.loadState(owner),
        ports.getPermission(),
      ]);
      if (currentUser.current !== owner) return;
      const on = state.choice === 'on' && permission.status === 'granted';
      setPushSetting(owner, on ? 'on' : 'off');
      if (on && registered.current !== owner) {
        // Sem rede ou sem token: tenta de novo na próxima abertura.
        await register(owner, platform).catch(() => undefined);
      }
    },
    [ports, register, setPushSetting],
  );

  // Sessão nova (login, abertura com sessão guardada): não lidas e registro do token.
  useEffect(() => {
    registered.current = null;
    if (userId === null) return;
    refreshUnread();
    void syncPush(userId).catch(() => undefined);
  }, [userId, refreshUnread, syncPush]);

  // Voltou para o app: acerta o ponto azul e a permissão (pode ter mudado nos Ajustes).
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active' || userId === null) return;
      refreshUnread();
      void syncPush(userId).catch(() => undefined);
    });
    return () => {
      subscription.remove();
    };
  }, [userId, refreshUnread, syncPush]);

  // Push com o app aberto: o ponto azul e a lista aberta atualizam.
  useEffect(
    () =>
      ports.onReceived(() => {
        refreshUnread();
        setPushTick((value) => value + 1);
      }),
    [ports, refreshUnread],
  );

  // Toques: o que abriu o app fechado e os que chegam com ele aberto ou em segundo plano.
  useEffect(() => {
    const launch = ports.takeLaunchResponse();
    if (launch !== null) {
      pendingResponse.current = launch;
      // Fora do corpo do efeito: o estado muda depois, como numa resposta.
      void Promise.resolve().then(() => {
        setResponseVersion((value) => value + 1);
      });
    }
    return ports.onResponse((response) => {
      pendingResponse.current = response;
      setResponseVersion((value) => value + 1);
    });
  }, [ports]);

  useEffect(() => {
    const response = pendingResponse.current;
    // Na abertura, espera a sessão ser restaurada e o app sair de "/" (o redirecionamento para a
    // aba inicial), para a navegação do push não ser trocada por ele.
    if (response === null || status === 'loading' || pathname === '/') return;
    pendingResponse.current = null;
    if (handledResponses.current.has(response.id)) return;
    handledResponses.current.add(response.id);
    // Sem sessão: o app só abre (a tela de Entrar), sem guardar o destino.
    if (status !== 'signedIn' || accountType === null) return;
    refreshUnread();
    const route = pushRouteFor(response.data, accountType);
    if (route !== null) router.navigate(route);
  }, [responseVersion, status, accountType, pathname, refreshUnread]);

  const enablePush = useCallback(async (): Promise<EnablePushResult> => {
    const platform = ports.platform;
    if (userId === null || platform === null) return 'failed';
    let permission = await ports.getPermission();
    if (permission.status !== 'granted') {
      if (!permission.canAskAgain) return 'blocked';
      permission = await ports.requestPermission();
      if (permission.status !== 'granted') {
        await ports.saveState(userId, { choice: 'off', token: null });
        setPushSetting(userId, 'off');
        return 'denied';
      }
    }
    try {
      await register(userId, platform);
      setPushSetting(userId, 'on');
      return 'on';
    } catch {
      await ports.saveState(userId, { choice: 'off', token: null });
      setPushSetting(userId, 'off');
      return 'failed';
    }
  }, [ports, register, setPushSetting, userId]);

  const disablePush = useCallback(async () => {
    if (userId === null) return;
    const state = await ports.loadState(userId);
    if (state.token !== null) await removePushToken(api, state.token);
    await ports.saveState(userId, { choice: 'off', token: null });
    registered.current = null;
    setPushSetting(userId, 'off');
  }, [api, ports, setPushSetting, userId]);

  const offerPush = useCallback(() => {
    if (userId === null || accountType === null || !supported || prompting.current) return;
    prompting.current = true;
    const ask = async () => {
      const state = await ports.loadState(userId);
      // Já perguntado neste aparelho (ativou, recusou ou desligou): nunca de novo (6.4 CA4).
      if (state.choice !== null) return;
      const permission = await ports.getPermission();
      // Fica registrado como perguntado antes da pergunta: fechar o app no meio não repete.
      await ports.saveState(userId, { choice: 'off', token: null });
      if (permission.status === 'denied' && !permission.canAskAgain) return;
      await sleep(timing.pushPromptDelayMs);
      if (currentUser.current !== userId) return;
      Alert.alert(
        PUSH_PROMPT_TITLE,
        pushPromptMessage(accountType),
        [
          { text: PUSH_PROMPT_LATER, style: 'cancel' },
          {
            text: PUSH_PROMPT_ENABLE,
            onPress: () => {
              void enablePush().then((result) => {
                if (result === 'failed')
                  toast.show({ message: PUSH_ENABLE_FAILED, variant: 'error' });
              });
            },
          },
        ],
        { cancelable: true },
      );
    };
    void ask()
      .catch(() => undefined)
      .finally(() => {
        prompting.current = false;
      });
  }, [accountType, enablePush, ports, supported, toast, userId]);

  // Primeiro post publicado (6.4 CA1). A primeira conexão chama o `offerPush` no Conectar.
  useEffect(
    () =>
      store.onCreated((post) => {
        if (isPublished(post)) offerPush();
      }),
    [offerPush, store],
  );

  const openPushSettings = useCallback(() => {
    void ports.openSettings().catch(() => undefined);
  }, [ports]);

  const value = useMemo<NotificationsContextValue>(
    () => ({
      unreadCount,
      pushTick,
      refreshUnread,
      setUnreadCount,
      offerPush,
      pushSetting,
      enablePush,
      disablePush,
      openPushSettings,
    }),
    [
      unreadCount,
      pushTick,
      refreshUnread,
      setUnreadCount,
      offerPush,
      pushSetting,
      enablePush,
      disablePush,
      openPushSettings,
    ],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsContextValue {
  const context = useContext(NotificationsContext);
  if (context === null) {
    throw new Error('useNotifications precisa de um <NotificationsProvider> acima na árvore.');
  }
  return context;
}
