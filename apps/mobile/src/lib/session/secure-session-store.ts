import * as SecureStore from 'expo-secure-store';

import type { RefreshTokenStore } from '../api/client';

const REFRESH_TOKEN_KEY = 'sussurro.refreshToken';
const LAST_EMAIL_KEY = 'sussurro.lastEmail';

/** Keychain/Keystore, só com o aparelho desbloqueado e sem ir para backup (ADR 0007). */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** O que o app guarda entre aberturas: o refresh token e o último e-mail digitado em Entrar. */
export interface SessionStore extends RefreshTokenStore {
  getLastEmail: () => Promise<string | null>;
  setLastEmail: (email: string) => Promise<void>;
}

/** Implementação com `expo-secure-store`. O access token nunca é gravado (AUTH-13). */
export const secureSessionStore: SessionStore = {
  getRefreshToken: () => SecureStore.getItemAsync(REFRESH_TOKEN_KEY, OPTIONS),
  setRefreshToken: (token) => SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, OPTIONS),
  clearRefreshToken: () => SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, OPTIONS),
  getLastEmail: () => SecureStore.getItemAsync(LAST_EMAIL_KEY, OPTIONS),
  setLastEmail: (email) => SecureStore.setItemAsync(LAST_EMAIL_KEY, email, OPTIONS),
};

/** Versão em memória, para os testes. */
export function createMemorySessionStore(initial: { refreshToken?: string } = {}) {
  const values = new Map<string, string>();
  if (initial.refreshToken !== undefined) {
    values.set(REFRESH_TOKEN_KEY, initial.refreshToken);
  }
  const store: SessionStore & { values: Map<string, string> } = {
    values,
    getRefreshToken: () => Promise.resolve(values.get(REFRESH_TOKEN_KEY) ?? null),
    setRefreshToken: (token) => {
      values.set(REFRESH_TOKEN_KEY, token);
      return Promise.resolve();
    },
    clearRefreshToken: () => {
      values.delete(REFRESH_TOKEN_KEY);
      return Promise.resolve();
    },
    getLastEmail: () => Promise.resolve(values.get(LAST_EMAIL_KEY) ?? null),
    setLastEmail: (email) => {
      values.set(LAST_EMAIL_KEY, email);
      return Promise.resolve();
    },
  };
  return store;
}
