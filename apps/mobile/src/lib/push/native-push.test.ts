const mockConstants: { expoConfig: { extra: Record<string, unknown> }; easConfig: null } = {
  expoConfig: { extra: {} },
  easConfig: null,
};
jest.mock('expo-constants', () => ({
  get expoConfig() {
    return mockConstants.expoConfig;
  },
  easConfig: null,
}));

import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';

import { configureNativePush, nativePush, parseDeviceState } from './native-push';

const notifications = jest.mocked(Notifications);

function response(actionIdentifier: string, data: unknown) {
  return {
    actionIdentifier,
    notification: { request: { identifier: 'n-1', content: { data } } },
  } as unknown as Notifications.NotificationResponse;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConstants.expoConfig.extra = {};
});

describe('nativePush (expo-notifications)', () => {
  it('permissão: concedida, negada e ainda não pedida', async () => {
    notifications.getPermissionsAsync.mockResolvedValueOnce({
      status: 'granted',
      granted: true,
      canAskAgain: true,
      expires: 'never',
    } as never);
    await expect(nativePush.getPermission()).resolves.toEqual({
      status: 'granted',
      canAskAgain: true,
    });
    notifications.getPermissionsAsync.mockResolvedValueOnce({
      status: 'denied',
      granted: false,
      canAskAgain: false,
      expires: 'never',
    } as never);
    await expect(nativePush.getPermission()).resolves.toEqual({
      status: 'denied',
      canAskAgain: false,
    });
    await expect(nativePush.getPermission()).resolves.toEqual({
      status: 'undetermined',
      canAskAgain: true,
    });
  });

  it('o pedido do sistema é só de alerta e som (sem número no ícone)', async () => {
    await expect(nativePush.requestPermission()).resolves.toEqual({
      status: 'granted',
      canAskAgain: true,
    });
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledWith({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
  });

  it('sem o projectId do EAS não pede o token; com ele, pede ao Expo', async () => {
    await expect(nativePush.getToken()).rejects.toThrow(/projectId/);
    expect(notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
    mockConstants.expoConfig.extra = { eas: { projectId: 'projeto-de-teste' } };
    await expect(nativePush.getToken()).resolves.toBe('ExponentPushToken[nativo]');
    expect(notifications.getExpoPushTokenAsync).toHaveBeenCalledWith({
      projectId: 'projeto-de-teste',
    });
  });

  it('o toque que abriu o app vem uma vez só e é limpo; ações que não são toque são ignoradas', () => {
    notifications.getLastNotificationResponse.mockReturnValueOnce(
      response(Notifications.DEFAULT_ACTION_IDENTIFIER, { type: 'post_liked', url: '/x' }),
    );
    expect(nativePush.takeLaunchResponse()).toEqual({
      id: 'n-1',
      data: { type: 'post_liked', url: '/x' },
    });
    expect(notifications.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
    expect(nativePush.takeLaunchResponse()).toBeNull();

    notifications.getLastNotificationResponse.mockReturnValueOnce(response('outra-acao', {}));
    expect(nativePush.takeLaunchResponse()).toBeNull();
  });

  it('toques com o app aberto: só a ação padrão chega ao app', () => {
    const listener = jest.fn();
    const stop = nativePush.onResponse(listener);
    const registered = notifications.addNotificationResponseReceivedListener.mock.calls[0]?.[0];
    registered?.(response('outra-acao', {}));
    registered?.(response(Notifications.DEFAULT_ACTION_IDENTIFIER, { type: 'post_liked' }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ id: 'n-1', data: { type: 'post_liked' } });
    stop();
  });

  it('com o app aberto: banner e lista, sem som e sem número no ícone', async () => {
    configureNativePush();
    const handler = notifications.setNotificationHandler.mock.calls[0]?.[0];
    await expect(handler?.handleNotification({} as Notifications.Notification)).resolves.toEqual({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });

  it('a escolha e o último token ficam no Keychain/Keystore, por conta', async () => {
    await nativePush.saveState('conta-1', { choice: 'on', token: 'ExponentPushToken[x]' });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'sussurro.push.conta-1',
      JSON.stringify({ choice: 'on', token: 'ExponentPushToken[x]' }),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
    await expect(nativePush.loadState('conta-1')).resolves.toEqual({
      choice: 'on',
      token: 'ExponentPushToken[x]',
    });
    await expect(nativePush.loadState('conta-2')).resolves.toEqual({ choice: null, token: null });
  });

  it('estado guardado estranho vale como "nunca perguntado"', () => {
    expect(parseDeviceState(null)).toEqual({ choice: null, token: null });
    expect(parseDeviceState('{')).toEqual({ choice: null, token: null });
    expect(parseDeviceState('null')).toEqual({ choice: null, token: null });
    expect(parseDeviceState('{"choice":"talvez","token":3}')).toEqual({
      choice: null,
      token: null,
    });
    expect(parseDeviceState('{"choice":"off"}')).toEqual({ choice: 'off', token: null });
  });
});
