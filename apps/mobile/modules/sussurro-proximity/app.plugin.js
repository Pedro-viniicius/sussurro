// Config plugin do módulo `sussurro-proximity` (ADR 0013 §4: NFC no lugar do Bluetooth). Em JS puro
// (CommonJS) para o `expo prebuild` e o EAS carregarem sem passo de build.
//
// Android: a permissão NFC, as features opcionais e o serviço HCE vêm do manifesto do módulo (merge
// do Gradle). Aqui ficam só o que o merge não cobre:
// - o intent-filter `NDEF_DISCOVERED` (`sussurro://c`) na MainActivity, para a tag lida com o app
//   fechado abrir o fluxo do código (o mesmo deep link do QR);
// - a remoção das declarações de Bluetooth e localização da versão BLE (ADR 0002/0012): as que
//   sobrarem no manifesto do app saem, e entradas `tools:node="remove"` tiram as que alguma
//   dependência trouxer pelo merge do Gradle.
// iOS: a NFCReaderUsageDescription em pt-BR e o entitlement de leitura NDEF. As chaves de
// Bluetooth saem do Info.plist. Nenhum modo de background.
const {
  AndroidConfig,
  createRunOncePlugin,
  withAndroidManifest,
  withEntitlementsPlist,
  withInfoPlist,
} = require('expo/config-plugins');

const NFC_USAGE =
  'O Sussurro usa o NFC só para ler o código de conexão de outra pessoa quando você aproxima os celulares, com a tela Conectar aberta.';

const NFC_PERMISSION = 'android.permission.NFC';

/** Entitlement do Core NFC. A Apple recusa "NDEF" desde o SDK do iOS 13 (ITMS-90778); "TAG" cobre a leitura NDEF. */
const NFC_ENTITLEMENT = 'com.apple.developer.nfc.readersession.formats';
const NFC_FORMATS = ['TAG'];

const NDEF_DISCOVERED = 'android.nfc.action.NDEF_DISCOVERED';
const DEEP_LINK = { scheme: 'sussurro', host: 'c' };

/** O que a versão BLE do módulo escrevia no manifesto do app e não pode sobrar. */
const REMOVED_ANDROID_PERMISSIONS = [
  'android.permission.BLUETOOTH',
  'android.permission.BLUETOOTH_ADMIN',
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_ADVERTISE',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
];
const REMOVED_ANDROID_FEATURES = ['android.hardware.bluetooth_le', 'android.hardware.bluetooth'];

/** Chaves de Bluetooth do Info.plist (a da versão BLE e a antiga, do iOS 12). */
const REMOVED_IOS_KEYS = [
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
];

const TOOLS_NAMESPACE = 'http://schemas.android.com/tools';

/** @param {string} name */
function removalEntry(name) {
  return { $: { 'android:name': name, 'tools:node': 'remove' } };
}

/**
 * Tira as permissões e features de Bluetooth e localização da versão BLE e acrescenta, para cada
 * uma, uma entrada `tools:node="remove"`: assim o merge do Gradle também tira as que vierem de uma
 * dependência. Garante o `xmlns:tools` na raiz do manifesto. Idempotente.
 * @param {{ manifest: Record<string, any> }} androidManifest
 */
function removeAndroidBluetooth(androidManifest) {
  const manifest = androidManifest.manifest;
  manifest.$ = { ...(manifest.$ ?? {}), 'xmlns:tools': TOOLS_NAMESPACE };
  const permissions = new Set(REMOVED_ANDROID_PERMISSIONS);
  const features = new Set(REMOVED_ANDROID_FEATURES);
  for (const key of ['uses-permission', 'uses-permission-sdk-23']) {
    if (Array.isArray(manifest[key])) {
      manifest[key] = manifest[key].filter((item) => !permissions.has(item.$['android:name']));
    }
  }
  manifest['uses-permission'] = [
    ...(manifest['uses-permission'] ?? []),
    ...REMOVED_ANDROID_PERMISSIONS.map(removalEntry),
  ];
  manifest['uses-feature'] = [
    ...(manifest['uses-feature'] ?? []).filter((item) => !features.has(item.$['android:name'])),
    ...REMOVED_ANDROID_FEATURES.map(removalEntry),
  ];
  return androidManifest;
}

/** @param {any} filter */
function isNdefDiscoveredFilter(filter) {
  return (filter.action ?? []).some((action) => action.$['android:name'] === NDEF_DISCOVERED);
}

/**
 * Na MainActivity: a tag com `sussurro://c/...` lida com o app fechado (ou fora da tela Conectar)
 * abre o app no deep link do código. Troca um filtro `NDEF_DISCOVERED` anterior (idempotente).
 * @param {{ manifest: Record<string, any> }} androidManifest
 */
function addNdefDiscoveredFilter(androidManifest) {
  const activity = AndroidConfig.Manifest.getMainActivityOrThrow(androidManifest);
  const filters = (activity['intent-filter'] ?? []).filter(
    (filter) => !isNdefDiscoveredFilter(filter),
  );
  filters.push({
    action: [{ $: { 'android:name': NDEF_DISCOVERED } }],
    category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
    data: [{ $: { 'android:scheme': DEEP_LINK.scheme, 'android:host': DEEP_LINK.host } }],
  });
  activity['intent-filter'] = filters;
  return androidManifest;
}

/**
 * A permissão NFC (normal, sem pedido na tela) também no manifesto do app: o merge do módulo já a
 * traz, mas assim o manifesto gerado mostra o que o app usa.
 * @param {{ manifest: Record<string, any> }} androidManifest
 */
function ensureNfcPermission(androidManifest) {
  const manifest = androidManifest.manifest;
  const permissions = manifest['uses-permission'] ?? [];
  if (!permissions.some((item) => item.$['android:name'] === NFC_PERMISSION)) {
    permissions.push({ $: { 'android:name': NFC_PERMISSION } });
  }
  manifest['uses-permission'] = permissions;
  return androidManifest;
}

/** @param {{ manifest: Record<string, any> }} androidManifest */
function setAndroidNfc(androidManifest) {
  return addNdefDiscoveredFilter(ensureNfcPermission(removeAndroidBluetooth(androidManifest)));
}

/**
 * Texto do pedido de NFC no iOS (aparece na folha do sistema) e sem as chaves de Bluetooth.
 * @param {Record<string, any>} infoPlist
 */
function setIosNfcUsage(infoPlist) {
  const removed = new Set(REMOVED_IOS_KEYS);
  const next = Object.fromEntries(Object.entries(infoPlist).filter(([key]) => !removed.has(key)));
  next.NFCReaderUsageDescription = NFC_USAGE;
  return next;
}

/** @param {Record<string, any>} entitlements */
function setIosNfcEntitlements(entitlements) {
  entitlements[NFC_ENTITLEMENT] = [...NFC_FORMATS];
  return entitlements;
}

/** @param {any} config */
function withSussurroProximity(config) {
  let next = withAndroidManifest(config, (modConfig) => {
    modConfig.modResults = setAndroidNfc(modConfig.modResults);
    return modConfig;
  });
  next = withInfoPlist(next, (modConfig) => {
    modConfig.modResults = setIosNfcUsage(modConfig.modResults);
    return modConfig;
  });
  next = withEntitlementsPlist(next, (modConfig) => {
    modConfig.modResults = setIosNfcEntitlements(modConfig.modResults);
    return modConfig;
  });
  return next;
}

module.exports = createRunOncePlugin(withSussurroProximity, 'sussurro-proximity', '0.2.0');
module.exports.NFC_USAGE = NFC_USAGE;
module.exports.NFC_ENTITLEMENT = NFC_ENTITLEMENT;
module.exports.NFC_FORMATS = NFC_FORMATS;
module.exports.REMOVED_ANDROID_PERMISSIONS = REMOVED_ANDROID_PERMISSIONS;
module.exports.REMOVED_ANDROID_FEATURES = REMOVED_ANDROID_FEATURES;
module.exports.REMOVED_IOS_KEYS = REMOVED_IOS_KEYS;
module.exports.setAndroidNfc = setAndroidNfc;
module.exports.removeAndroidBluetooth = removeAndroidBluetooth;
module.exports.addNdefDiscoveredFilter = addNdefDiscoveredFilter;
module.exports.setIosNfcUsage = setIosNfcUsage;
module.exports.setIosNfcEntitlements = setIosNfcEntitlements;
