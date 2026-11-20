import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Configuração do app por variante (infra.md §5). `APP_VARIANT` vem do perfil do `eas.json`
 * ou do `.env` do app. Dev e produção convivem no mesmo celular (bundle ids diferentes).
 * Identificador definitivo decidido pelo PO: `app.sussurro` (N1).
 */
export type AppVariant = 'development' | 'preview' | 'production';

const VARIANTS: Record<AppVariant, { name: string; id: string }> = {
  development: { name: 'Sussurro Dev', id: 'app.sussurro.dev' },
  preview: { name: 'Sussurro Preview', id: 'app.sussurro.preview' },
  production: { name: 'Sussurro', id: 'app.sussurro' },
};

const BRAND_BLUE = '#0066FF';

/**
 * Texto do pedido de acesso às fotos (iOS). O app usa o seletor do sistema (PHPicker / Photo Picker),
 * também para os vídeos dos reels (Fase 5), que não pede acesso à biblioteca inteira; a chave fica no
 * Info.plist porque o módulo a referencia.
 * O microfone não é usado: os plugins removem a chave e bloqueiam a permissão no Android. O app não
 * pede localização (o Conectar usa NFC e QR code, ADR 0013); as fotos saem sem GPS (MID-05).
 */
export const PHOTOS_PERMISSION_TEXT =
  'O Sussurro abre as fotos e os vídeos que você escolher para publicar ou usar como foto de perfil. A localização das fotos é removida antes de publicar.';

/**
 * Texto do pedido da câmera (Fase 4, história 4.7): só a leitura do QR code na tela Conectar. Nada é
 * fotografado nem gravado. O seletor de fotos recebe o mesmo texto (ele não abre a câmera).
 */
export const CAMERA_PERMISSION_TEXT =
  'O Sussurro usa a câmera só para ler o QR code de outra pessoa na tela Conectar. Nada é fotografado nem gravado.';

/**
 * Reels (Fase 5): o vídeo só toca com o app aberto. Sem áudio em segundo plano (nada de
 * `UIBackgroundModes` nem serviço em primeiro plano no Android) e sem picture-in-picture.
 */
export const VIDEO_PLUGIN_OPTIONS = {
  supportsBackgroundPlayback: false,
  supportsPictureInPicture: false,
} as const;

/** Config plugin do módulo local de NFC (ADR 0013 §4: HCE, leitura NDEF e o deep link da tag). */
export const PROXIMITY_PLUGIN = './modules/sussurro-proximity/app.plugin.js';

/**
 * Projeto do EAS (expo.dev, slug `sussurro`), criado pelo PO com `eas init` em 2026-10-30. Não é
 * segredo: fica no repositório para o `eas build` funcionar sem configurar variável. O
 * `EAS_PROJECT_ID` do ambiente, se preenchido, tem precedência.
 */
export const EAS_PROJECT_ID = 'd52fca2b-c3b1-4623-9191-0987ddf8ab1f';

/**
 * Variáveis do build (EAS ou shell). Nenhuma é segredo e nenhuma fica no repositório:
 * - `EAS_PROJECT_ID`: troca o projeto do EAS (o padrão é a constante acima); sem projeto, o app não
 *   pede o token de push (Fase 6);
 * - `GOOGLE_SERVICES_JSON`: caminho do `google-services.json` do Firebase (FCM do Android), como
 *   variável de arquivo do EAS;
 * - `SENTRY_ORG` e `SENTRY_PROJECT`: upload dos source maps no EAS Build, junto do
 *   `SENTRY_AUTH_TOKEN` (secret do EAS). O token nunca entra na configuração: só se ele existe
 *   (`sentryAuthTokenSet`), para desligar o upload quando falta (sem ele o build falharia).
 */
export interface BuildEnv {
  EAS_PROJECT_ID?: string | undefined;
  GOOGLE_SERVICES_JSON?: string | undefined;
  SENTRY_ORG?: string | undefined;
  SENTRY_PROJECT?: string | undefined;
  sentryAuthTokenSet?: boolean;
}

function filled(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/**
 * Push (Fase 6, ADR 0011): ícone branco da barra de status e cor da marca no Android; o canal
 * `default` é o que o Expo usa sem `channelId`. Sem notificações em segundo plano silenciosas
 * (`UIBackgroundModes` continua vazio) e sem sons próprios. O `aps-environment` do iOS segue a
 * variante (o export do EAS ajusta ao perfil de distribuição).
 */
export function notificationsPluginOptions(variant: AppVariant): Record<string, unknown> {
  return {
    icon: './assets/images/adaptive-icon-monochrome.png',
    color: BRAND_BLUE,
    defaultChannel: 'default',
    mode: variant === 'development' ? 'development' : 'production',
    enableBackgroundRemoteNotifications: false,
  };
}

/**
 * Só o `expo-notifications` usa o `RECEIVE_BOOT_COMPLETED` (para reagendar notificações locais
 * depois de reiniciar o aparelho). O app não agenda nada: o push remoto chega pelo FCM sem ele.
 */
export const ANDROID_BLOCKED_PERMISSIONS = ['android.permission.RECEIVE_BOOT_COMPLETED'];

/**
 * Preview e produção também tiram o `SYSTEM_ALERT_WINDOW` (sobreposição de tela), que o template do
 * prebuild põe no manifesto principal. O app não desenha sobre outros apps: só as ferramentas de
 * desenvolvimento do React Native (o monitor de desempenho) usam, e elas ficam no dev build. O job
 * `native` do CI pegou a permissão no manifesto de release (docs/deploy/lojas.md).
 */
export const ANDROID_RELEASE_BLOCKED_PERMISSIONS = [
  ...ANDROID_BLOCKED_PERMISSIONS,
  'android.permission.SYSTEM_ALERT_WINDOW',
];

export function resolveVariant(value: string | undefined): AppVariant {
  if (value === undefined || value === '') {
    return 'development';
  }
  if (value === 'development' || value === 'preview' || value === 'production') {
    return value;
  }
  throw new Error(`APP_VARIANT inválida: "${value}" (use development, preview ou production).`);
}

export function buildAppConfig(
  variant: AppVariant,
  base: Partial<ExpoConfig> = {},
  env: BuildEnv = {},
): ExpoConfig {
  const { name, id } = VARIANTS[variant];
  const projectId = filled(env.EAS_PROJECT_ID) ?? EAS_PROJECT_ID;
  const googleServicesFile = filled(env.GOOGLE_SERVICES_JSON);
  const sentryOrg = filled(env.SENTRY_ORG);
  const sentryProject = filled(env.SENTRY_PROJECT);
  const sentryUpload =
    env.sentryAuthTokenSet === true && sentryOrg !== undefined && sentryProject !== undefined;
  // HTTP em claro e rede local só no dev build: o celular fala com a API pelo IP da LAN.
  // Preview e produção nunca têm essas exceções (infra.md §5.4, F0-APP-05).
  const isDev = variant === 'development';

  return {
    ...base,
    name,
    slug: 'sussurro',
    scheme: 'sussurro',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    backgroundColor: '#FFFFFF',
    icon: './assets/images/icon.png',
    ios: {
      bundleIdentifier: id,
      supportsTablet: false,
      // Conformidade de exportação (docs/deploy/lojas.md §3): o app só usa a criptografia padrão do
      // sistema (HTTPS e o Keychain do `expo-secure-store`), que é isenta. Vira o
      // `ITSAppUsesNonExemptEncryption: false` do Info.plist, e o App Store Connect não pergunta a
      // cada build.
      config: { usesNonExemptEncryption: false },
      infoPlist: isDev
        ? {
            NSAppTransportSecurity: { NSAllowsLocalNetworking: true },
            NSLocalNetworkUsageDescription:
              'O app de desenvolvimento acessa o computador na rede local para carregar o código.',
          }
        : {},
    },
    android: {
      package: id,
      blockedPermissions: isDev ? ANDROID_BLOCKED_PERMISSIONS : ANDROID_RELEASE_BLOCKED_PERMISSIONS,
      ...(googleServicesFile === undefined ? {} : { googleServicesFile }),
      adaptiveIcon: {
        foregroundImage: './assets/images/adaptive-icon.png',
        monochromeImage: './assets/images/adaptive-icon-monochrome.png',
        backgroundColor: BRAND_BLUE,
      },
    },
    plugins: [
      'expo-router',
      [
        'expo-splash-screen',
        { backgroundColor: BRAND_BLUE, image: './assets/images/splash-icon.png', imageWidth: 96 },
      ],
      ['expo-build-properties', { android: { usesCleartextTraffic: isDev } }],
      [
        'expo-image-picker',
        {
          photosPermission: PHOTOS_PERMISSION_TEXT,
          cameraPermission: CAMERA_PERMISSION_TEXT,
          microphonePermission: false,
        },
      ],
      'expo-image',
      [
        'expo-camera',
        {
          cameraPermission: CAMERA_PERMISSION_TEXT,
          microphonePermission: false,
          recordAudioAndroid: false,
          barcodeScannerEnabled: true,
        },
      ],
      ['expo-video', VIDEO_PLUGIN_OPTIONS],
      PROXIMITY_PLUGIN,
      ['expo-notifications', notificationsPluginOptions(variant)],
      // O plugin aponta `fullBackupContent` e `dataExtractionRules` do manifesto para as regras que
      // tiram o SharedPreferences do SecureStore do Auto Backup e da transferência de aparelho: o
      // refresh token cifrado não volta sem a chave do Keystore e não quebra o login. O app não usa
      // `requireAuthentication`, então sem `NSFaceIDUsageDescription` (o padrão a poria, em inglês).
      ['expo-secure-store', { configureAndroidBackup: true, faceIDPermission: false }],
      // Source maps no EAS Build (6.7 CA3). As chaves existem sempre (sem o aviso "Missing config"
      // a cada `expo start`). Sem o token, a organização ou o projeto, o upload fica desligado e o
      // build não falha (os eventos chegam sem source maps).
      [
        '@sentry/react-native/expo',
        {
          url: 'https://sentry.io/',
          organization: sentryOrg,
          project: sentryProject,
          disableAutoUpload: !sentryUpload,
        },
      ],
    ],
    experiments: { typedRoutes: true },
    extra: {
      appVariant: variant,
      eas: { projectId },
    },
  };
}

export default ({ config }: ConfigContext): ExpoConfig =>
  buildAppConfig(resolveVariant(process.env.APP_VARIANT), config, {
    EAS_PROJECT_ID: process.env.EAS_PROJECT_ID,
    GOOGLE_SERVICES_JSON: process.env.GOOGLE_SERVICES_JSON,
    SENTRY_ORG: process.env.SENTRY_ORG,
    SENTRY_PROJECT: process.env.SENTRY_PROJECT,
    sentryAuthTokenSet: filled(process.env.SENTRY_AUTH_TOKEN) !== undefined,
  });
