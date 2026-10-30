import { type AccountType, PushDataSchema, pushTargetUrl } from '@sussurro/shared';

/**
 * Para onde vai o toque num push (6.5 CA5, 6.6): o `data` passa pelo `PushDataSchema` antes de
 * qualquer navegação, e só a rota que o servidor monta para aquele tipo e aquela conta
 * (`pushTargetUrl`) é aceita. `data` inválido, de outro tipo de conta ou com outra rota → `null`
 * (o app só abre, sem navegar).
 */
export function pushRouteFor(data: unknown, accountType: AccountType): string | null {
  const parsed = PushDataSchema.safeParse(data);
  if (!parsed.success) return null;
  const expected = pushTargetUrl(parsed.data.type, accountType);
  return parsed.data.url === expected ? expected : null;
}
