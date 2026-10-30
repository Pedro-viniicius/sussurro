import type { ReportTarget } from '@sussurro/shared';

import { withQuery } from '../../lib/api/query';
import { ROUTES } from '../navigation/routes';

/** Parâmetros da rota `/denunciar` (o alvo vai na query, em pt-BR). */
export interface ReportRouteParams {
  alvo?: string;
  id?: string;
  handle?: string;
}

/** `/denunciar?alvo=publicacao&id=…`, `alvo=comentario&id=…` ou `alvo=conta&handle=…`. */
export function reportHref(target: ReportTarget): string {
  switch (target.type) {
    case 'post':
      return withQuery(ROUTES.report, { alvo: 'publicacao', id: target.id });
    case 'comment':
      return withQuery(ROUTES.report, { alvo: 'comentario', id: target.id });
    case 'account':
      return withQuery(ROUTES.report, { alvo: 'conta', handle: target.handle });
  }
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
