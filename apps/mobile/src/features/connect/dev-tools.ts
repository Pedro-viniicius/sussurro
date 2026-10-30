import Constants from 'expo-constants';

function appVariant(): string {
  const extra = Constants.expoConfig?.extra as { appVariant?: string } | undefined;
  return extra?.appVariant ?? 'development';
}

/**
 * "Simular um pedido recebido" (4.11, D15): só no build de desenvolvimento rodando em modo dev.
 * Nunca em `preview` nem `production`, nem com `EXPO_PUBLIC_DEV_TOOLS=1` (4.11 CA3). A rota da API
 * também só existe com `NODE_ENV=development`.
 */
export function isSimulationEnabled(
  dev: boolean = __DEV__,
  variant: string = appVariant(),
): boolean {
  return dev && variant === 'development';
}
