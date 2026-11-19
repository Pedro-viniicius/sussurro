interface ManifestItem {
  $: Record<string, string>;
}
interface IntentFilter {
  action?: ManifestItem[];
  category?: ManifestItem[];
  data?: ManifestItem[];
}
interface AndroidManifest {
  manifest: Record<string, unknown> & {
    'uses-permission'?: ManifestItem[];
    'uses-feature'?: ManifestItem[];
    application?: {
      $: Record<string, string>;
      activity?: (ManifestItem & { 'intent-filter'?: IntentFilter[] })[];
    }[];
  };
}
interface ProximityPlugin {
  NFC_USAGE: string;
  NFC_ENTITLEMENT: string;
  setAndroidNfc: (manifest: AndroidManifest) => AndroidManifest;
  setIosNfcUsage: (plist: Record<string, unknown>) => Record<string, unknown>;
  setIosNfcEntitlements: (entitlements: Record<string, unknown>) => Record<string, unknown>;
}

const plugin = require('../app.plugin.js') as ProximityPlugin;

function bleManifest(): AndroidManifest {
  return {
    manifest: {
      'uses-permission': [
        { $: { 'android:name': 'android.permission.INTERNET' } },
        { $: { 'android:name': 'android.permission.BLUETOOTH', 'android:maxSdkVersion': '30' } },
        { $: { 'android:name': 'android.permission.BLUETOOTH_SCAN' } },
        { $: { 'android:name': 'android.permission.BLUETOOTH_ADVERTISE' } },
        { $: { 'android:name': 'android.permission.BLUETOOTH_CONNECT' } },
        { $: { 'android:name': 'android.permission.ACCESS_FINE_LOCATION' } },
      ],
      'uses-feature': [
        { $: { 'android:name': 'android.hardware.bluetooth_le', 'android:required': 'false' } },
      ],
      application: [
        {
          $: { 'android:name': '.MainApplication' },
          activity: [
            {
              $: { 'android:name': '.MainActivity' },
              'intent-filter': [
                {
                  action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
                  category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

describe('sussurro-proximity: config plugin do NFC (ADR 0013 §4)', () => {
  it('NFC-07 (plugin): Android: tira Bluetooth e localização, garante NFC e abre o app pela tag sussurro://c', () => {
    const result = plugin.setAndroidNfc(bleManifest());
    const permissions = result.manifest['uses-permission'] ?? [];
    const kept = permissions.filter((p) => p.$['tools:node'] !== 'remove');
    expect(kept.map((p) => p.$['android:name'])).toStrictEqual([
      'android.permission.INTERNET',
      'android.permission.NFC',
    ]);
    // O merge do Gradle tira também o que uma dependência trouxer (tools:node="remove").
    const removed = permissions.filter((p) => p.$['tools:node'] === 'remove');
    expect(removed.map((p) => p.$['android:name'])).toStrictEqual([
      'android.permission.BLUETOOTH',
      'android.permission.BLUETOOTH_ADMIN',
      'android.permission.BLUETOOTH_SCAN',
      'android.permission.BLUETOOTH_ADVERTISE',
      'android.permission.BLUETOOTH_CONNECT',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.ACCESS_BACKGROUND_LOCATION',
    ]);
    expect(result.manifest['uses-feature']).toStrictEqual([
      { $: { 'android:name': 'android.hardware.bluetooth_le', 'tools:node': 'remove' } },
      { $: { 'android:name': 'android.hardware.bluetooth', 'tools:node': 'remove' } },
    ]);
    expect(result.manifest.$).toStrictEqual({
      'xmlns:tools': 'http://schemas.android.com/tools',
    });

    const filters = result.manifest.application?.[0]?.activity?.[0]?.['intent-filter'] ?? [];
    expect(filters).toHaveLength(2);
    expect(filters[1]).toStrictEqual({
      action: [{ $: { 'android:name': 'android.nfc.action.NDEF_DISCOVERED' } }],
      category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
      data: [{ $: { 'android:scheme': 'sussurro', 'android:host': 'c' } }],
    });
  });

  it('NFC-07 (plugin): Android: aplicar duas vezes não duplica a permissão nem o filtro', () => {
    const twice = plugin.setAndroidNfc(plugin.setAndroidNfc(bleManifest()));
    const names = (twice.manifest['uses-permission'] ?? []).map((p) => p.$['android:name']);
    expect(names.filter((name) => name === 'android.permission.NFC')).toHaveLength(1);
    expect(names.filter((name) => name === 'android.permission.BLUETOOTH_SCAN')).toHaveLength(1);
    expect(twice.manifest['uses-feature']).toHaveLength(2);
    expect(twice.manifest.application?.[0]?.activity?.[0]?.['intent-filter']).toHaveLength(2);
  });

  it('NFC-07 (plugin): iOS: texto do NFC em pt-BR, sem as chaves de Bluetooth, e o entitlement TAG', () => {
    const plist = plugin.setIosNfcUsage({
      NSBluetoothAlwaysUsageDescription: 'antigo',
      NSBluetoothPeripheralUsageDescription: 'antigo',
      CFBundleName: 'Sussurro',
    });
    expect(plist).toStrictEqual({
      CFBundleName: 'Sussurro',
      NFCReaderUsageDescription:
        'O Sussurro usa o NFC só para ler o código de conexão de outra pessoa quando você aproxima os celulares, com a tela Conectar aberta.',
    });
    expect(plugin.setIosNfcEntitlements({})).toStrictEqual({
      'com.apple.developer.nfc.readersession.formats': ['TAG'],
    });
  });
});
