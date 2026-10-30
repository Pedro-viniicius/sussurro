import { PermissionStatus } from 'expo';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Linking, Platform } from 'react-native';

import type {
  PushDeviceState,
  PushPermission,
  PushPermissionStatus,
  PushPorts,
  PushResponse,
} from './ports';

/**
 * Canal do Android (8+). O worker não manda `channelId`, e o Expo usa o canal `default` quando ele
 * existe; sem nenhum canal o Android 13+ nem mostra o pedido de permissão.
 */
export const ANDROID_CHANNEL_ID = 'default';
export const ANDROID_CHANNEL_NAME = 'Notificações';

/** Keychain/Keystore, só com o aparelho desbloqueado e sem backup (igual à sessão, ADR 0007). */
const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

function stateKey(userId: string): string {
  return `sussurro.push.${userId}`;
}

function toPermission(result: Notifications.NotificationPermissionsStatus): PushPermission {
  const status: PushPermissionStatus = result.granted
    ? 'granted'
    : result.status === PermissionStatus.DENIED
      ? 'denied'
      : 'undetermined';
  return { status, canAskAgain: result.canAskAgain };
}

function toResponse(response: Notifications.NotificationResponse): PushResponse {
  return {
    id: response.notification.request.identifier,
    data: response.notification.request.content.data,
  };
}

function isTap(response: Notifications.NotificationResponse): boolean {
  return response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER;
}

/** `projectId` do EAS (`EAS_PROJECT_ID` no build, ver o `app.config.ts`). */
function easProjectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  const fromExtra = extra?.eas?.projectId;
  if (fromExtra !== undefined && fromExtra !== '') return fromExtra;
  const fromEas = Constants.easConfig?.projectId;
  return fromEas === undefined || fromEas === '' ? undefined : fromEas;
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_ID, {
    name: ANDROID_CHANNEL_NAME,
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

/**
 * Com o app aberto, o push aparece como banner e na central, sem som e sem número no ícone (o
 * Sussurro não usa badge). Chamado uma vez, antes de qualquer tela.
 */
export function configureNativePush(): void {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return;
  Notifications.setNotificationHandler({
    handleNotification: () =>
      Promise.resolve({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
  });
}

export const nativePush: PushPorts = {
  platform: Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : null,

  getPermission: async () => toPermission(await Notifications.getPermissionsAsync()),

  requestPermission: async () => {
    await ensureAndroidChannel();
    // Só alerta e som: o app não usa o número no ícone (minimização).
    const result = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    return toPermission(result);
  },

  getToken: async () => {
    const projectId = easProjectId();
    if (projectId === undefined) {
      throw new Error('Push indisponível: o build não tem o projectId do EAS (EAS_PROJECT_ID).');
    }
    await ensureAndroidChannel();
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return token.data;
  },

  onReceived: (listener) => {
    const subscription = Notifications.addNotificationReceivedListener(() => {
      listener();
    });
    return () => {
      subscription.remove();
    };
  },

  onResponse: (listener) => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      if (isTap(response)) listener(toResponse(response));
    });
    return () => {
      subscription.remove();
    };
  },

  takeLaunchResponse: () => {
    const response = Notifications.getLastNotificationResponse();
    if (response === null) return null;
    Notifications.clearLastNotificationResponse();
    return isTap(response) ? toResponse(response) : null;
  },

  loadState: async (userId) => {
    const raw = await SecureStore.getItemAsync(stateKey(userId), STORE_OPTIONS);
    return parseDeviceState(raw);
  },

  saveState: (userId, state) =>
    SecureStore.setItemAsync(stateKey(userId), JSON.stringify(state), STORE_OPTIONS),

  openSettings: () => Linking.openSettings(),
};

/** Estado guardado; qualquer coisa estranha vale como "nunca perguntado". */
export function parseDeviceState(raw: string | null): PushDeviceState {
  const empty: PushDeviceState = { choice: null, token: null };
  if (raw === null) return empty;
  try {
    const value = JSON.parse(raw) as Partial<PushDeviceState> | null;
    if (value === null || typeof value !== 'object') return empty;
    const choice = value.choice === 'on' || value.choice === 'off' ? value.choice : null;
    const token = typeof value.token === 'string' ? value.token : null;
    return { choice, token };
  } catch {
    return empty;
  }
}
