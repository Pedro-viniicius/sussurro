// Confere o manifesto Android final (docs/deploy/lojas.md, "Permissões"; ADR 0013).
// Uso: node scripts/check-android-manifest.mjs <AndroidManifest.xml final>
// Roda no job "native" do CI contra o manifesto final de release
// (`merged_manifests/release/processReleaseManifest`, depois do ajuste de `maxSdkVersion` do Expo).
// Aqui na máquina, serve contra o de debug do prebuild, que traz a mais as permissões do dev build.
//
// Lista de PERMITIDAS: qualquer permissão fora dela falha, inclusive uma que uma biblioteca nova
// traga pelo merge (AD_ID, ACCESS_MEDIA_LOCATION, READ_MEDIA_*, SYSTEM_ALERT_WINDOW...). Para aceitar
// uma permissão nova, ela entra aqui e na tabela do lojas.md, com a origem, no mesmo PR.
// Falha fechado, saindo com 1, quando:
// - aparece uma permissão fora da lista;
// - READ_/WRITE_EXTERNAL_STORAGE aparecem sem `maxSdkVersion` <= 32 (só valem até o Android 12L);
// - falta a permissão NFC, ou o serviço HCE `SussurroNdefService` sem `BIND_NFC_SERVICE`;
// - o `<application>` deixa o backup ligado (`allowBackup="true"`, ou sem o atributo, que vale true)
//   sem `fullBackupContent` e `dataExtractionRules` apontando para as regras do expo-secure-store,
//   que tiram o SharedPreferences `SecureStore` (o login) do Auto Backup e da transferência entre
//   aparelhos. Exige os nomes exatos: o plugin do secure-store não aplica as regras dele se outra
//   lib já tiver posto as suas (só avisa no prebuild), e aí o login voltaria ao backup.
//   Aceita a forma `@xml/...` do manifesto mesclado do Gradle e do `bundletool dump manifest`;
//   um id hexadecimal (`@0x7f...`) não é resolvido e falha.
//   Com o backup ligado, também falha qualquer `android:backupAgent`, mesmo com
//   `fullBackupOnly="true"`: o agente pode sobrescrever `onFullBackup` e ignorar as regras XML, e o
//   app não tem agente próprio (um que apareça veio de uma biblioteca e precisa de revisão).
//   Limite: confere só o NOME das regras, não o conteúdo dos XMLs (dívida no lojas.md).
// Sempre lista as permissões encontradas (e o resumo do run, no CI).
import { appendFileSync, readFileSync } from 'node:fs';

// Origem de cada uma: relatório do merger (app/build/outputs/logs/manifest-merger-*-report.txt).
const ALLOWED = new Set([
  'android.permission.NFC', // módulo sussurro-proximity (Conectar)
  'android.permission.CAMERA', // expo-camera (QR code) e expo-image-picker
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.ACCESS_WIFI_STATE', // expo-network
  'android.permission.POST_NOTIFICATIONS', // expo-notifications e FCM
  'android.permission.WAKE_LOCK', // FCM e media3 (vídeo)
  'com.google.android.c2dm.permission.RECEIVE', // FCM
  'android.permission.VIBRATE', // expo-haptics
  'android.permission.USE_BIOMETRIC', // androidx.biometric (expo-secure-store)
  'android.permission.USE_FINGERPRINT', // androidx.biometric (expo-secure-store)
  'com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE', // installreferrer
  // Badge do ícone em launchers de fabricantes (ShortcutBadger, do expo-notifications).
  'android.permission.READ_APP_BADGE',
  'com.anddoes.launcher.permission.UPDATE_COUNT',
  'com.android.launcher.permission.INSTALL_SHORTCUT',
  'com.android.launcher.permission.READ_SETTINGS',
  'com.android.launcher.permission.UNINSTALL_SHORTCUT',
  'com.android.launcher.permission.WRITE_SETTINGS',
  'com.htc.launcher.permission.READ_SETTINGS',
  'com.htc.launcher.permission.UPDATE_SHORTCUT',
  'com.huawei.android.launcher.permission.CHANGE_BADGE',
  'com.huawei.android.launcher.permission.READ_SETTINGS',
  'com.huawei.android.launcher.permission.WRITE_SETTINGS',
  'com.majeur.launcher.permission.UPDATE_BADGE',
  'com.oppo.launcher.permission.READ_SETTINGS',
  'com.oppo.launcher.permission.WRITE_SETTINGS',
  'com.sec.android.provider.badge.permission.READ',
  'com.sec.android.provider.badge.permission.WRITE',
  'com.sonyericsson.home.permission.BROADCAST_BADGE',
  'com.sonymobile.home.permission.PROVIDER_INSERT_BADGE',
  'me.everything.badger.permission.BADGE_COUNT_READ',
  'me.everything.badger.permission.BADGE_COUNT_WRITE',
]);
// Permissão interna do próprio app (androidx.core), com o id de cada variante (app.config.ts).
const OWN_RECEIVER = /^app\.sussurro(\.(dev|preview))?\.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION$/;
// Armazenamento legado: aceito só até o Android 12L (API 32); vem do template do prebuild e do
// expo-file-system, expo-image e expo-image-picker. No Android 13+ o app usa o Photo Picker.
const LEGACY_STORAGE = /^android\.permission\.(READ|WRITE)_EXTERNAL_STORAGE$/;
const LEGACY_MAX_SDK = 32;
const REQUIRED = ['android.permission.NFC'];
const HCE_SERVICE = 'expo.modules.sussurroproximity.SussurroNdefService';
// Regras de backup do plugin do expo-secure-store (app.config.ts).
const BACKUP_RULES = {
  'android:fullBackupContent': '@xml/secure_store_backup_rules', // Android 11 e anteriores
  'android:dataExtractionRules': '@xml/secure_store_data_extraction_rules', // Android 12+
};

const file = process.argv[2];
if (file === undefined) {
  console.error('uso: node scripts/check-android-manifest.mjs <AndroidManifest.xml>');
  process.exit(2);
}
const xml = readFileSync(file, 'utf8');

// `uses-permission` e `uses-permission-sdk-23`, com o `maxSdkVersion` quando houver. O manifesto
// final não traz as entradas `tools:node="remove"`: o que sobra aqui vai para o aparelho.
const entries = [...xml.matchAll(/<uses-permission(?:-sdk-23)?\b[^>]*>/g)]
  .map((m) => ({
    name: /\bandroid:name="([^"]+)"/.exec(m[0])?.[1],
    maxSdk: /\bandroid:maxSdkVersion="(\d+)"/.exec(m[0])?.[1],
  }))
  .filter((e) => e.name !== undefined);
const permissions = [...new Set(entries.map((e) => e.name))].sort();

const errors = [];
for (const e of entries) {
  if (LEGACY_STORAGE.test(e.name)) {
    if (!(Number(e.maxSdk) <= LEGACY_MAX_SDK)) {
      errors.push(
        `${e.name} sem maxSdkVersion <= ${LEGACY_MAX_SDK} (valeria no Android 13+; lojas.md)`,
      );
    }
  } else if (!ALLOWED.has(e.name) && !OWN_RECEIVER.test(e.name)) {
    errors.push(`permissão fora da lista de permitidas (lojas.md): ${e.name}`);
  }
}
for (const p of REQUIRED) {
  if (!permissions.includes(p)) {
    errors.push(`permissão obrigatória ausente: ${p}`);
  }
}

const service = [...xml.matchAll(/<service\b[^>]*>/g)]
  .map((m) => m[0])
  .find((tag) => tag.includes(`android:name="${HCE_SERVICE}"`));
if (service === undefined) {
  errors.push(`serviço HCE ausente: ${HCE_SERVICE}`);
} else if (!service.includes('android:permission="android.permission.BIND_NFC_SERVICE"')) {
  errors.push(`serviço HCE sem android:permission="android.permission.BIND_NFC_SERVICE"`);
}

// Backup: sem `allowBackup="false"`, o Auto Backup vale e precisa das regras do secure-store.
const applications = [...xml.matchAll(/<application\b[^>]*>/g)].map((m) => m[0]);
let backupStatus = '';
if (applications.length !== 1) {
  errors.push(`esperava 1 tag <application>, achou ${applications.length}`);
} else {
  const app = applications[0];
  const attr = (name) => new RegExp(`\\b${name}="([^"]*)"`).exec(app)?.[1];
  const allowBackup = attr('android:allowBackup');
  if (allowBackup === 'false') {
    backupStatus = 'allowBackup="false" (sem backup)';
  } else {
    const shown =
      allowBackup === undefined
        ? 'allowBackup ausente (padrão true)'
        : `allowBackup="${allowBackup}"`;
    const found = Object.entries(BACKUP_RULES).map(([name, expected]) => ({
      name,
      expected,
      value: attr(name),
    }));
    backupStatus = `${shown}; ${found.map((f) => `${f.name}=${f.value ?? '(ausente)'}`).join('; ')}`;
    const agent = attr('android:backupAgent');
    if (agent !== undefined) {
      backupStatus += `; android:backupAgent=${agent}`;
      errors.push(
        `<application> com ${shown} e android:backupAgent="${agent}": o agente decide o que vai para o backup e pode ignorar as regras do SecureStore (lojas.md)`,
      );
    }
    for (const f of found) {
      if (f.value !== f.expected) {
        errors.push(
          `<application> com ${shown} e ${f.name}=${f.value === undefined ? '(ausente)' : `"${f.value}"`}; esperado "${f.expected}" (login do SecureStore iria para o backup; lojas.md)`,
        );
      }
    }
  }
}
const uniqueErrors = [...new Set(errors)];

const describe = (e) => `${e.name}${e.maxSdk === undefined ? '' : ` (maxSdkVersion ${e.maxSdk})`}`;
console.log(`${permissions.length} permissões em ${file}:`);
for (const e of entries) {
  console.log(`  ${describe(e)}`);
}
console.log(`Backup: ${backupStatus || '(sem <application>)'}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const lines = [
    '### Permissões do manifesto Android final',
    '',
    ...entries.map((e) => `- \`${describe(e)}\``),
    '',
    `Backup: \`${backupStatus || '(sem <application>)'}\``,
    '',
    uniqueErrors.length === 0
      ? '✅ Só permissões da lista de permitidas; NFC e HCE presentes; backup sem o SecureStore.'
      : '❌ Falhou:',
    ...uniqueErrors.map((e) => `- ${e}`),
    '',
  ];
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

if (uniqueErrors.length > 0) {
  for (const e of uniqueErrors) {
    console.error(`::error::${e}`);
  }
  process.exit(1);
}
console.log(
  'OK: só permissões da lista de permitidas; NFC e o serviço HCE estão presentes; o backup exclui o SecureStore.',
);
