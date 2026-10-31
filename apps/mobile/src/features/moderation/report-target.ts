import type { ReportTarget } from '@sussurro/shared';

import { queryString } from '../../lib/api/query';
import { ROUTES } from '../navigation/routes';

/** Parâmetros da rota `/denunciar` (o alvo vai na query, em pt-BR). */
export interface ReportRouteParams {
  alvo?: string;
  id?: string;
  handle?: string;
}

/** O alvo da denúncia na query, em pt-BR. */
function reportQuery(target: ReportTarget): ReportRouteParams {
  switch (target.type) {
    case 'post':
      return { alvo: 'publicacao', id: target.id };
    case 'comment':
      return { alvo: 'comentario', id: target.id };
    case 'account':
      return { alvo: 'conta', handle: target.handle };
  }
}

/** `/denunciar?alvo=publicacao&id=…`, `alvo=comentario&id=…` ou `alvo=conta&handle=…`. */
export function reportHref(target: ReportTarget): `${typeof ROUTES.report}?${string}` {
  return `${ROUTES.report}?${queryString({ ...reportQuery(target) })}`;
}

/** O alvo de volta a partir da query; `null` se faltar algo (link quebrado). */
export function reportTargetFrom(params: ReportRouteParams): ReportTarget | null {
  const id = params.id ?? '';
  const handle = params.handle ?? '';
  if (params.alvo === 'publicacao' && id !== '') return { type: 'post', id };
  if (params.alvo === 'comentario' && id !== '') return { type: 'comment', id };
  if (params.alvo === 'conta' && handle !== '') return { type: 'account', handle };
  return null;
}
