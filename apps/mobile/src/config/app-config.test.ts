import {
  ANDROID_BLOCKED_PERMISSIONS,
  ANDROID_RELEASE_BLOCKED_PERMISSIONS,
  type AppVariant,
  buildAppConfig,
  CAMERA_PERMISSION_TEXT,
  EAS_PROJECT_ID,
  PHOTOS_PERMISSION_TEXT,
  PROXIMITY_PLUGIN,
  resolveVariant,
  VIDEO_PLUGIN_OPTIONS,
} from '../../app.config';

interface ManifestEntry {
  $: Record<string, string>;
}

interface ProximityPlugin {
  NFC_USAGE: string;
  NFC_ENTITLEMENT: string;
  NFC_FORMATS: string[];
  setAndroidNfc: (manifest: { manifest: Record<string, unknown> }) => {
    manifest: Record<string, unknown>;
  };
  setIosNfcUsage: (plist: Record<string, unknown>) => Record<string, unknown>;
  setIosNfcEntitlements: (entitlements: Record<string, unknown>) => Record<string, unknown>;
}

const proximityPlugin =
  require('../../modules/sussurro-proximity/app.plugin.js') as ProximityPlugin;

type Plugin = string | [string, Record<string, unknown>];

function plugin(
  variant: AppVariant,
  name: string,
  env: Parameters<typeof buildAppConfig>[2] = {},
): Record<string, unknown> | undefined {
  const plugins = (buildAppConfig(variant, {}, env).plugins ?? []) as Plugin[];
  const found = plugins.find((p) => (Array.isArray(p) ? p[0] : p) === name);
  return Array.isArray(found) ? found[1] : undefined;
}

describe('app.config', () => {
  it('CA4 (0.7): bundle ids e nomes diferentes por variante', () => {
    const ids = (['development', 'preview', 'production'] as const).map((variant) => {
      const config = buildAppConfig(variant);
      expect(config.ios?.bundleIdentifier).toBe(config.android?.package);
      return config.ios?.bundleIdentifier;
    });
    expect(ids).toEqual(['app.sussurro.dev', 'app.sussurro.preview', 'app.sussurro']);
    expect(buildAppConfig('production').name).toBe('Sussurro');
  });

  it('F0-APP-05: só development libera HTTP em claro (Android) e rede local (ATS)', () => {
    expect(plugin('development', 'expo-build-properties')).toEqual({
      android: { usesCleartextTraffic: true },
    });
    expect(buildAppConfig('development').ios?.infoPlist).toMatchObject({
      NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
    });

    for (const variant of ['preview', 'production'] as const) {
      expect(plugin(variant, 'expo-build-properties')).toEqual({
        android: { usesCleartextTraffic: false },
      });
      expect(buildAppConfig(variant).ios?.infoPlist).toEqual({});
    }
  });

  it('CA3 (0.7): só retrato; marca no ícone e no splash', () => {
    const config = buildAppConfig('production');
    expect(config.orientation).toBe('portrait');
    expect(config.scheme).toBe('sussurro');
    expect(config.android?.adaptiveIcon?.backgroundColor).toBe('#0066FF');
    expect(plugin('production', 'expo-splash-screen')).toMatchObject({
      backgroundColor: '#0066FF',
      image: './assets/images/splash-icon.png',
    });
  });

  it('Fase 2 e 4: fotos e câmera com texto em pt-BR, sem microfone; a câmera só lê o QR', () => {
    for (const variant of ['development', 'preview', 'production'] as const) {
      expect(plugin(variant, 'expo-image-picker')).toEqual({
        photosPermission: PHOTOS_PERMISSION_TEXT,
        cameraPermission: CAMERA_PERMISSION_TEXT,
        microphonePermission: false,
      });
      expect(plugin(variant, 'expo-camera')).toEqual({
        cameraPermission: CAMERA_PERMISSION_TEXT,
        microphonePermission: false,
        recordAudioAndroid: false,
        barcodeScannerEnabled: true,
      });
      const plugins = (buildAppConfig(variant).plugins ?? []) as Plugin[];
      expect(plugins).toContain(PROXIMITY_PLUGIN);
      const config = JSON.stringify(buildAppConfig(variant));
      expect(config).not.toMatch(/Location|LOCATION/);
    }
    expect(PHOTOS_PERMISSION_TEXT).toMatch(/fotos e os vídeos que você escolher/);
    expect(CAMERA_PERMISSION_TEXT).toMatch(/só para ler o QR code/);
  });

  it('NFC-07 (ADR 0013 §4): Android só com a permissão NFC; o Bluetooth e a localização da versão BLE saem do manifesto', () => {
    const manifest = proximityPlugin.setAndroidNfc({
      manifest: {
        'uses-permission': [
          { $: { 'android:name': 'android.permission.INTERNET' } },
          { $: { 'android:name': 'android.permission.BLUETOOTH_SCAN' } },
          { $: { 'android:name': 'android.permission.ACCESS_FINE_LOCATION' } },
        ],
        'uses-feature': [
          { $: { 'android:name': 'android.hardware.bluetooth_le', 'android:required': 'false' } },
        ],
        application: [
          {
            $: { 'android:name': '.MainApplication' },
            activity: [{ $: { 'android:name': '.MainActivity' } }],
          },
        ],
      },
    }).manifest;
    const names = ((manifest['uses-permission'] ?? []) as ManifestEntry[])
      .filter((entry) => entry.$['tools:node'] !== 'remove')
      .map((entry) => entry.$['android:name'] ?? '');
    expect(names).toContain('android.permission.NFC');
    expect(names).toContain('android.permission.INTERNET');
    expect(names.some((name) => /BLUETOOTH|LOCATION/.test(name))).toBe(false);
    const features = ((manifest['uses-feature'] ?? []) as ManifestEntry[])
      .filter((entry) => entry.$['tools:node'] !== 'remove')
      .map((entry) => entry.$['android:name'] ?? '');
    expect(features.some((name) => name.includes('bluetooth'))).toBe(false);
  });

  it('Fase 5: o expo-video sem áudio em segundo plano e sem picture-in-picture', () => {
    for (const variant of ['development', 'preview', 'production'] as const) {
      expect(plugin(variant, 'expo-video')).toEqual({
        supportsBackgroundPlayback: false,
        supportsPictureInPicture: false,
      });
    }
    expect(VIDEO_PLUGIN_OPTIONS).toEqual({
      supportsBackgroundPlayback: false,
      supportsPictureInPicture: false,
    });
  });

  it('NFC-07 (ADR 0013 §4): iOS com o texto do NFC em pt-BR e o entitlement TAG, sem Bluetooth nem modo de background', () => {
    const plist = proximityPlugin.setIosNfcUsage({
      NSBluetoothAlwaysUsageDescription: 'antigo',
    });
    expect(plist).toEqual({ NFCReaderUsageDescription: proximityPlugin.NFC_USAGE });
    expect(proximityPlugin.NFC_USAGE).toBe(
      'O Sussurro usa o NFC só para ler o código de conexão de outra pessoa quando você aproxima os celulares, com a tela Conectar aberta.',
    );
    expect(proximityPlugin.NFC_FORMATS).toEqual(['TAG']);
    expect(proximityPlugin.setIosNfcEntitlements({})).toEqual({
      [proximityPlugin.NFC_ENTITLEMENT]: ['TAG'],
    });
  });

  it('Fase 6: expo-notifications com o ícone branco, a cor da marca e sem push silencioso', () => {
    expect(plugin('development', 'expo-notifications')).toEqual({
      icon: './assets/images/adaptive-icon-monochrome.png',
      color: '#0066FF',
      defaultChannel: 'default',
      mode: 'development',
      enableBackgroundRemoteNotifications: false,
    });
    for (const variant of ['preview', 'production'] as const) {
      expect(plugin(variant, 'expo-notifications')).toMatchObject({ mode: 'production' });
      // O RECEIVE_BOOT_COMPLETED do expo-notifications sai (o app não agenda notificações) e, fora
      // do dev build, o SYSTEM_ALERT_WINDOW do template (job "native" do CI, lojas.md).
      expect(buildAppConfig(variant).android?.blockedPermissions).toEqual(
        ANDROID_RELEASE_BLOCKED_PERMISSIONS,
      );
    }
    expect(ANDROID_BLOCKED_PERMISSIONS).toEqual(['android.permission.RECEIVE_BOOT_COMPLETED']);
    expect(ANDROID_RELEASE_BLOCKED_PERMISSIONS).toEqual([
      'android.permission.RECEIVE_BOOT_COMPLETED',
      'android.permission.SYSTEM_ALERT_WINDOW',
    ]);
    // O dev build mantém a sobreposição para o monitor de desempenho do React Native.
    expect(buildAppConfig('development').android?.blockedPermissions).toEqual(
      ANDROID_BLOCKED_PERMISSIONS,
    );
    // Nenhum modo de background no iOS (nem remote-notification).
    expect(JSON.stringify(buildAppConfig('production'))).not.toMatch(/UIBackgroundModes/);
  });

  it('Fase 6: projectId do EAS fixo (o ambiente pode trocar); google-services.json só pelo ambiente', () => {
    const bare = buildAppConfig('production');
    expect(bare.extra).toEqual({ appVariant: 'production', eas: { projectId: EAS_PROJECT_ID } });
    expect(EAS_PROJECT_ID).toBe('d52fca2b-c3b1-4623-9191-0987ddf8ab1f');
    expect(bare.android).not.toHaveProperty('googleServicesFile');
    const withEnv = buildAppConfig(
      'production',
      {},
      {
        EAS_PROJECT_ID: ' projeto-123 ',
        GOOGLE_SERVICES_JSON: '/eas/secrets/google-services.json',
      },
    );
    expect(withEnv.extra).toEqual({ appVariant: 'production', eas: { projectId: 'projeto-123' } });
    expect(withEnv.android?.googleServicesFile).toBe('/eas/secrets/google-services.json');
  });

  it('6.7 CA3: source maps só com token, organização e projeto; o token nunca entra na config', () => {
    expect(plugin('production', '@sentry/react-native/expo')).toEqual({
      url: 'https://sentry.io/',
      organization: undefined,
      project: undefined,
      disableAutoUpload: true,
    });
    const env = { SENTRY_ORG: 'sussurro', SENTRY_PROJECT: 'sussurro-mobile' };
    expect(plugin('production', '@sentry/react-native/expo', env)).toMatchObject({
      disableAutoUpload: true,
    });
    const upload = plugin('production', '@sentry/react-native/expo', {
      ...env,
      sentryAuthTokenSet: true,
    });
    expect(upload).toEqual({
      url: 'https://sentry.io/',
      organization: 'sussurro',
      project: 'sussurro-mobile',
      disableAutoUpload: false,
    });
    expect(upload).not.toHaveProperty('authToken');
    expect(
      JSON.stringify(buildAppConfig('production', {}, { ...env, sentryAuthTokenSet: true })),
    ).not.toMatch(/authToken|SENTRY_AUTH_TOKEN/);
  });

  it('resolveVariant: padrão development; valor desconhecido falha', () => {
    expect(resolveVariant(undefined)).toBe('development');
    expect(resolveVariant('preview')).toBe('preview');
    expect(() => resolveVariant('staging')).toThrow(/APP_VARIANT inválida/);
  });
});
