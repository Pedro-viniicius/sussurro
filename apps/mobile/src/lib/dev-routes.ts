/**
 * Rotas `/dev/*` (catálogo e, a partir da Fase 1, ferramentas de teste) só existem em
 * desenvolvimento ou num build que defina `EXPO_PUBLIC_DEV_TOOLS=1` (ux.md §6.15).
 * O perfil `production` do EAS nunca define a variável.
 */
export function isDevRoutesEnabled(
  dev: boolean = __DEV__,
  flag: string | undefined = process.env.EXPO_PUBLIC_DEV_TOOLS,
): boolean {
  return dev || flag === '1';
}
