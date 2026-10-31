// Config plugin do módulo `sussurro-proximity` (ADR 0002, história 4.3 CA5). Em JS puro (CommonJS)
// para o `expo prebuild` e o EAS carregarem sem passo de build.
//
// Android 12+ (API 31+): só "Dispositivos próximos": BLUETOOTH_SCAN com `neverForLocation` (a
// varredura não é usada para localizar), BLUETOOTH_ADVERTISE e BLUETOOTH_CONNECT.
// Android ≤ 11 (API ≤ 30): o sistema exige localização para varrer BLE, então ACCESS_FINE_LOCATION
// entra com `maxSdkVersion="30"`, junto com BLUETOOTH e BLUETOOTH_ADMIN (permissões normais).
// iOS: só a NSBluetoothAlwaysUsageDescription, em pt-BR (T39 do ux.md §11.9, ADR 0012: o
// Bluetooth só serve para perceber o encosto). Nenhum modo de background.
const { createRunOncePlugin, withAndroidManifest, withInfoPlist } = require('expo/config-plugins');

const BLUETOOTH_USAGE =
  'O Sussurro usa o Bluetooth só para perceber quando o seu celular encosta no de outra pessoa, com a tela Conectar aberta. Ninguém vê sua localização, e nada é transmitido com o app fechado.';

/** Até Android 11 (API 30). */
const LEGACY_MAX_SDK = '30';

const ANDROID_PERMISSIONS = [
  { name: 'android.permission.BLUETOOTH', maxSdkVersion: LEGACY_MAX_SDK },
  { name: 'android.permission.BLUETOOTH_ADMIN', maxSdkVersion: LEGACY_MAX_SDK },
  { name: 'android.permission.ACCESS_FINE_LOCATION', maxSdkVersion: LEGACY_MAX_SDK },
  { name: 'android.permission.BLUETOOTH_SCAN', usesPermissionFlags: 'neverForLocation' },
  { name: 'android.permission.BLUETOOTH_ADVERTISE' },
  { name: 'android.permission.BLUETOOTH_CONNECT' },
];

const BLE_FEATURE = 'android.hardware.bluetooth_le';

/**
 * Escreve as permissões de Bluetooth no manifesto do app, trocando qualquer declaração anterior
 * com o mesmo nome (para os atributos `maxSdkVersion` e `usesPermissionFlags` valerem). O BLE é
 * opcional na loja (`required="false"`): sem ele, o app oferece o QR code.
 * @param {{ manifest: Record<string, any> }} androidManifest
 */
function setAndroidBluetoothPermissions(androidManifest) {
  const manifest = androidManifest.manifest;
  const names = new Set(ANDROID_PERMISSIONS.map((permission) => permission.name));
  const others = (manifest['uses-permission'] ?? []).filter(
    (item) => !names.has(item.$['android:name']),
  );
  manifest['uses-permission'] = [
    ...others,
    ...ANDROID_PERMISSIONS.map((permission) => ({
      $: {
        'android:name': permission.name,
        ...(permission.maxSdkVersion === undefined
          ? {}
          : { 'android:maxSdkVersion': permission.maxSdkVersion }),
        ...(permission.usesPermissionFlags === undefined
          ? {}
          : { 'android:usesPermissionFlags': permission.usesPermissionFlags }),
      },
    })),
  ];
  const features = (manifest['uses-feature'] ?? []).filter(
    (item) => item.$['android:name'] !== BLE_FEATURE,
  );
  manifest['uses-feature'] = [
    ...features,
    { $: { 'android:name': BLE_FEATURE, 'android:required': 'false' } },
  ];
  return androidManifest;
}

/**
 * Texto do pedido de Bluetooth no iOS (o mesmo da explicação antes do pedido, ux.md §4.12).
 * @param {Record<string, any>} infoPlist
 */
function setIosBluetoothUsage(infoPlist) {
  infoPlist.NSBluetoothAlwaysUsageDescription = BLUETOOTH_USAGE;
  return infoPlist;
}

/** @param {any} config */
function withSussurroProximity(config) {
  let next = withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = setAndroidBluetoothPermissions(modConfig.modResults);
    return modConfig;
  });
  next = withInfoPlist(next, (modConfig) => {
    modConfig.modResults = setIosBluetoothUsage(modConfig.modResults);
    return modConfig;
  });
  return next;
}

module.exports = createRunOncePlugin(withSussurroProximity, 'sussurro-proximity', '0.1.0');
module.exports.BLUETOOTH_USAGE = BLUETOOTH_USAGE;
module.exports.ANDROID_PERMISSIONS = ANDROID_PERMISSIONS;
module.exports.setAndroidBluetoothPermissions = setAndroidBluetoothPermissions;
module.exports.setIosBluetoothUsage = setIosBluetoothUsage;
