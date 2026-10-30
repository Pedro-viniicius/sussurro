import { ApiClient } from './client';
import { secureSessionStore } from '../session/secure-session-store';

/** URL da API (perfil do EAS ou `apps/mobile/.env`). Sem barra no fim. */
export function apiBaseUrl(value: string | undefined = process.env.EXPO_PUBLIC_API_URL): string {
  const url = value === undefined || value.trim() === '' ? 'http://localhost:3000' : value.trim();
  return url.replace(/\/+$/, '');
}

/** Cliente único do app: `fetch` nativo + refresh no secure-store. */
export const apiClient = new ApiClient({
  baseUrl: apiBaseUrl(),
  fetch: (url, init) => fetch(url, init),
  tokens: secureSessionStore,
});
