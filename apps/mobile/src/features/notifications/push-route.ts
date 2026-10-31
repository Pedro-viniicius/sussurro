import { type AccountType, PushDataSchema, pushTargetUrl } from '@sussurro/shared';

import { ROUTES } from '../navigation/routes';

/** As únicas telas que um push abre (as que o servidor monta em `pushTargetUrl`). */
const PUSH_ROUTES = [
  ROUTES.personalNotifications,
  ROUTES.creatorNotifications,
  ROUTES.personalConnect,
] as const;
export type PushRoute = (typeof PUSH_ROUTES)[number];

function isPushRoute(value: string): value is PushRoute {
  return (PUSH_ROUTES as readonly string[]).includes(value);
}

/**
 * Para onde vai o toque num push (6.5 CA5, 6.6): o `data` passa pelo `PushDataSchema` antes de
 * qualquer navegação, e só a rota que o servidor monta para aquele tipo e aquela conta
 * (`pushTargetUrl`) é aceita, e só se for uma tela conhecida do app. `data` inválido, de outro
 * tipo de conta ou com outra rota → `null` (o app só abre, sem navegar).
 */
export function pushRouteFor(data: unknown, accountType: AccountType): PushRoute | null {
  const parsed = PushDataSchema.safeParse(data);
  if (!parsed.success) return null;
  const expected = pushTargetUrl(parsed.data.type, accountType);
  return parsed.data.url === expected && isPushRoute(expected) ? expected : null;
}
