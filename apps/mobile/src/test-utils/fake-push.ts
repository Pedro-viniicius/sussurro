import type { PushDeviceState, PushPermission, PushPorts, PushResponse } from '../lib/push/ports';

export const FAKE_PUSH_TOKEN = 'ExponentPushToken[aparelho-de-teste]';

export interface FakePushOptions {
  permission?: PushPermission;
  /** O que o pedido do sistema responde (padrão: concede). */
  answer?: PushPermission;
  token?: string;
  /** `getToken` falha (sem projectId, sem rede). */
  tokenFails?: boolean;
  launchResponse?: PushResponse | null;
  /** Estado guardado por conta (`userId` → estado). */
  states?: Record<string, PushDeviceState>;
}

/**
 * Notificações do aparelho falsas: permissão controlada pelo teste, token fixo, toques e pushes
 * disparados à mão (`tap`, `receive`) e o estado guardado em memória.
 */
export function createFakePush({
  permission = { status: 'undetermined', canAskAgain: true },
  answer = { status: 'granted', canAskAgain: true },
  token = FAKE_PUSH_TOKEN,
  tokenFails = false,
  launchResponse = null,
  states = {},
}: FakePushOptions = {}) {
  const responseListeners = new Set<(response: PushResponse) => void>();
  const receivedListeners = new Set<() => void>();
  const stored = new Map<string, PushDeviceState>(Object.entries(states));
  let launch = launchResponse;

  const fake = {
    permission,
    answer,
    tokenFails,
    requests: 0,
    tokenCalls: 0,
    settingsOpened: 0,
    stored,
    ports: {} as PushPorts,
    /** Toque numa notificação com o app aberto ou em segundo plano. */
    tap(data: unknown, id = `n-${String(Math.random())}`) {
      for (const listener of responseListeners) listener({ id, data });
    },
    /** Push que chega com o app aberto. */
    receive() {
      for (const listener of receivedListeners) listener();
    },
  };

  fake.ports = {
    platform: 'ios',
    getPermission: () => Promise.resolve(fake.permission),
    requestPermission: () => {
      fake.requests += 1;
      fake.permission = fake.answer;
      return Promise.resolve(fake.answer);
    },
    getToken: () => {
      fake.tokenCalls += 1;
      return fake.tokenFails ? Promise.reject(new Error('sem projectId')) : Promise.resolve(token);
    },
    onReceived: (listener) => {
      receivedListeners.add(listener);
      return () => {
        receivedListeners.delete(listener);
      };
    },
    onResponse: (listener) => {
      responseListeners.add(listener);
      return () => {
        responseListeners.delete(listener);
      };
    },
    takeLaunchResponse: () => {
      const value = launch;
      launch = null;
      return value;
    },
    loadState: (userId) => Promise.resolve(stored.get(userId) ?? { choice: null, token: null }),
    saveState: (userId, state) => {
      stored.set(userId, state);
      return Promise.resolve();
    },
    openSettings: () => {
      fake.settingsOpened += 1;
      return Promise.resolve();
    },
  };
  return fake;
}

export type FakePush = ReturnType<typeof createFakePush>;
