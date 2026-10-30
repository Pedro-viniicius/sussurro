import {
  ANDROID_BLOCKED_PERMISSIONS,
  type AppVariant,
  buildAppConfig,
  CAMERA_PERMISSION_TEXT,
  PHOTOS_PERMISSION_TEXT,
  PROXIMITY_PLUGIN,
  resolveVariant,
  VIDEO_PLUGIN_OPTIONS,
} from '../../app.config';

interface ManifestEntry {
  $: Record<string, string>;
}

interface ProximityPlugin {
  BLUETOOTH_USAGE: string;
  setAndroidBluetoothPermissions: (manifest: { manifest: Record<string, ManifestEntry[]> }) => {
    manifest: Record<string, ManifestEntry[]>;
  };
  setIosBluetoothUsage: (plist: Record<string, unknown>) => Record<string, unknown>;
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

  it('4.3 CA5: Android 12+ só BLUETOOTH_SCAN (neverForLocation), ADVERTISE e CONNECT; localização só até o Android 11', () => {
    const manifest = proximityPlugin.setAndroidBluetoothPermissions({
      manifest: {
        'uses-permission': [
          { $: { 'android:name': 'android.permission.INTERNET' } },
          // Uma declaração anterior sem limite é trocada pela com maxSdkVersion.
          { $: { 'android:name': 'android.permission.ACCESS_FINE_LOCATION' } },
        ],
      },
    }).manifest;
    const permissions = (manifest['uses-permission'] ?? []).map((entry) => entry.$);
    const byName = (name: string) =>
      permissions.filter((entry) => entry['android:name'] === `android.permission.${name}`);

    expect(byName('BLUETOOTH_SCAN')).toEqual([
      {
        'android:name': 'android.permission.BLUETOOTH_SCAN',
        'android:usesPermissionFlags': 'neverForLocation',
      },
    ]);
    expect(byName('BLUETOOTH_ADVERTISE')).toEqual([
      { 'android:name': 'android.permission.BLUETOOTH_ADVERTISE' },
    ]);
    expect(byName('BLUETOOTH_CONNECT')).toEqual([
      { 'android:name': 'android.permission.BLUETOOTH_CONNECT' },
    ]);
    for (const legacy of ['ACCESS_FINE_LOCATION', 'BLUETOOTH', 'BLUETOOTH_ADMIN']) {
      expect(byName(legacy)).toEqual([
        { 'android:name': `android.permission.${legacy}`, 'android:maxSdkVersion': '30' },
      ]);
    }
    // Nada de localização aproximada nem em background; o resto do manifesto fica.
    const names = permissions.map((entry) => entry['android:name'] ?? '');
    expect(names.some((name) => /COARSE|BACKGROUND_LOCATION/.test(name))).toBe(false);
    expect(byName('INTERNET')).toHaveLength(1);
    // O BLE não é obrigatório para instalar (sem ele, o QR).
    expect(manifest['uses-feature']).toEqual([
      { $: { 'android:name': 'android.hardware.bluetooth_le', 'android:required': 'false' } },
    ]);
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

  it('4.3: iOS só com o texto do Bluetooth em pt-BR, sem modo de background', () => {
    const plist = proximityPlugin.setIosBluetoothUsage({});
    expect(plist).toEqual({ NSBluetoothAlwaysUsageDescription: proximityPlugin.BLUETOOTH_USAGE });
    expect(proximityPlugin.BLUETOOTH_USAGE).toMatch(/Ninguém vê sua localização/);
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
      // Só o RECEIVE_BOOT_COMPLETED do expo-notifications sai (o app não agenda notificações).
      expect(buildAppConfig(variant).android?.blockedPermissions).toEqual(
        ANDROID_BLOCKED_PERMISSIONS,
      );
    }
    expect(ANDROID_BLOCKED_PERMISSIONS).toEqual(['android.permission.RECEIVE_BOOT_COMPLETED']);
    // Nenhum modo de background no iOS (nem remote-notification).
    expect(JSON.stringify(buildAppConfig('production'))).not.toMatch(/UIBackgroundModes/);
  });

  it('Fase 6: projectId do EAS e google-services.json só pelo ambiente do build', () => {
    const bare = buildAppConfig('production');
    expect(bare.extra).toEqual({ appVariant: 'production' });
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
