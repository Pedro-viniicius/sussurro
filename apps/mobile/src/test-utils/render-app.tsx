import type { Me } from '@sussurro/shared';
import { ToastProvider, UiPreferencesProvider } from '@sussurro/ui';
import { renderRouter } from 'expo-router/testing-library';

import { BASE_URL, createFakeApi, type FakeApi, tokenPair } from './fake-api';
import { createFakeMedia, type FakeMedia } from './fake-media';
import { createFakePush, type FakePush } from './fake-push';
import { createFakeRadio, type FakeRadio } from '../../modules/sussurro-proximity/src/fake-radio';
import { AuthProvider } from '../features/auth/AuthProvider';
import { RadioProvider } from '../features/connect/RadioProvider';
import { RootNavigator } from '../features/navigation/RootNavigator';
import { ApiClient } from '../lib/api/client';
import { MediaProvider } from '../lib/media/MediaProvider';
import { PushProvider } from '../lib/push/PushProvider';
import { createMemorySessionStore } from '../lib/session/secure-session-store';

export interface RenderAppOptions {
  initialUrl?: string;
  /** Sessão guardada no aparelho: a abertura faz refresh e `GET /me` com este usuário. */
  signedInAs?: Me;
  /** Respostas extras da API falsa. */
  configure?: (api: FakeApi) => void;
  /** Seletor de fotos e S3 falsos (padrão: um novo, vazio). */
  media?: FakeMedia;
  /** Rádio BLE falso (padrão: um novo, com Bluetooth ligado e permitido). */
  radio?: FakeRadio;
  /** Notificações do aparelho falsas (padrão: permissão ainda não pedida, nada guardado). */
  push?: FakePush;
}

/**
 * Caminho absoluto de `src/app` (o ponyfill do require.context exige absoluto). O Jest roda com o
 * diretório do app como cwd (`pnpm test` e o turbo rodam no pacote).
 */
const APP_DIR = `${(process as unknown as { cwd: () => string }).cwd()}/src/app`;

/**
 * Sobe o app de verdade (as rotas de `src/app`) com a pilha raiz real, trocando só a casca:
 * a API é falsa, a sessão fica em memória e o acesso às fotos e ao S3 é um dublê.
 */
export async function renderApp({
  initialUrl = '/',
  signedInAs,
  configure,
  media = createFakeMedia(),
  radio = createFakeRadio(),
  push = createFakePush(),
}: RenderAppOptions = {}) {
  const api = createFakeApi();
  const store = createMemorySessionStore(signedInAs === undefined ? {} : { refreshToken: 'r0' });
  if (signedInAs !== undefined) {
    api.on('POST /v1/auth/refresh', () => ({ status: 200, body: tokenPair() }));
    api.on('GET /v1/me', { status: 200, body: signedInAs });
    // Padrões da Fase 2 (feed e abas do perfil vazios); `configure` pode trocar.
    api.on('GET /v1/feed', {
      status: 200,
      body: { items: [], nextCursor: null, caughtUp: true, windowHours: 72 },
    });
    api.on(`GET /v1/users/${signedInAs.handle}/posts`, {
      status: 200,
      body: { items: [], nextCursor: null },
    });
    // Fase 6: sem notificações por padrão.
    api.on('GET /v1/notifications/unread-count', { status: 200, body: { count: 0 } });
    api.on('GET /v1/notifications', { status: 200, body: { items: [], nextCursor: null } });
  }
  configure?.(api);
  const client = new ApiClient({ baseUrl: BASE_URL, fetch: api.fetch, tokens: store });

  function TestRoot() {
    return (
      <UiPreferencesProvider reduceMotion>
        <ToastProvider>
          <MediaProvider value={media.ports}>
            <RadioProvider value={radio}>
              <PushProvider value={push.ports}>
                <AuthProvider api={client} store={store}>
                  <RootNavigator />
                </AuthProvider>
              </PushProvider>
            </RadioProvider>
          </MediaProvider>
        </ToastProvider>
      </UiPreferencesProvider>
    );
  }

  const result = await renderRouter(
    { appDir: APP_DIR, overrides: { _layout: TestRoot } },
    { initialUrl },
  );
  return { ...result, api, client, store, media, radio, push };
}
