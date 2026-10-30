import {
  type BlockRequest,
  type BlocksPage,
  BlocksPageSchema,
  type ConnectionsPage,
  ConnectionsPageSchema,
  type CreateReportInput,
  type CreatorSearchResult,
  CreatorSearchResultSchema,
  type FollowingPage,
  FollowingPageSchema,
  type FollowState,
  FollowStateSchema,
  NoContentSchema,
  PAGE_SIZE_DEFAULT,
} from '@sussurro/shared';

import type { ApiClient } from '../../lib/api/client';
import { withQuery } from '../../lib/api/query';

/**
 * Rotas da Fase 3 (contrato em packages/shared: search.ts, relations.ts, reports.ts). Toda
 * resposta passa pelo schema Zod; o `code` dos erros escolhe a mensagem em `lib/error-messages.ts`.
 */

const handlePath = (value: string) => encodeURIComponent(value);

/** `GET /search/creators?q=` (só pessoa). O termo já vem normalizado e válido (BUS-11). */
export function searchCreators(api: ApiClient, term: string): Promise<CreatorSearchResult> {
  return api.request(withQuery('/v1/search/creators', { q: term }), {
    schema: CreatorSearchResultSchema,
  });
}

/** `PUT` (seguir) ou `DELETE` (deixar de seguir) `/creators/:handle/follow`, idempotentes. */
export function setFollow(api: ApiClient, handle: string, follow: boolean): Promise<FollowState> {
  return api.request(`/v1/creators/${handlePath(handle)}/follow`, {
    method: follow ? 'PUT' : 'DELETE',
    schema: FollowStateSchema,
  });
}

/** `GET /me/connections`: só a própria lista (3.6). */
export function fetchConnections(api: ApiClient, cursor?: string): Promise<ConnectionsPage> {
  return api.request(withQuery('/v1/me/connections', { cursor, limit: PAGE_SIZE_DEFAULT }), {
    schema: ConnectionsPageSchema,
  });
}

/** `GET /me/following`: só a própria lista (3.6). */
export function fetchFollowing(api: ApiClient, cursor?: string): Promise<FollowingPage> {
  return api.request(withQuery('/v1/me/following', { cursor, limit: PAGE_SIZE_DEFAULT }), {
    schema: FollowingPageSchema,
  });
}

/** `GET /me/blocks`: contas bloqueadas, só o @ e a data (X.2). */
export function fetchBlocks(api: ApiClient, cursor?: string): Promise<BlocksPage> {
  return api.request(withQuery('/v1/me/blocks', { cursor, limit: PAGE_SIZE_DEFAULT }), {
    schema: BlocksPageSchema,
  });
}

/** `POST /me/blocks` pelo @ ou pelo comentário: sempre 204 (não vira oráculo de @). */
export function blockAccount(api: ApiClient, body: BlockRequest): Promise<undefined> {
  return api.request('/v1/me/blocks', { method: 'POST', body, schema: NoContentSchema });
}

/** `DELETE /me/blocks/:handle`: 204. Não refaz conexão nem follows. */
export function unblockAccount(api: ApiClient, handle: string): Promise<undefined> {
  return api.request(`/v1/me/blocks/${handlePath(handle)}`, {
    method: 'DELETE',
    schema: NoContentSchema,
  });
}

/** `POST /reports` → 202 sem corpo (X.1). A conta denunciada não é avisada. */
export function createReport(api: ApiClient, body: CreateReportInput): Promise<undefined> {
  return api.request('/v1/reports', { method: 'POST', body, schema: NoContentSchema });
}
