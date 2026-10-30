import { Inject, Injectable } from '@nestjs/common';
import { type DbHandle, type SQL, sql } from '@sussurro/db';

import type { AuthContext } from '../../common/auth/auth-context.js';
import { rowsOf } from '../../common/db/rows.js';
import { DATABASE } from '../../infra/database/database.providers.js';

/** Posição na lista: `created_at` exato (texto com microssegundos) e o id da conta (desempate). */
export interface OwnListAnchor {
  at: string;
  id: string;
}

export interface OwnListPageQuery {
  after: OwnListAnchor | undefined;
  limit: number;
}

/** Uma conta numa lista própria, com a chave de ordenação para o cursor. */
export interface OwnListRow {
  id: string;
  handle: string;
  name: string;
  avatarKey: string | null;
  since: Date;
  /** `created_at` exato, para o cursor não perder nem repetir itens no mesmo milissegundo. */
  sinceKey: string;
}

interface RawRow {
  id: string;
  handle: string;
  name: string;
  avatar_key: string | null;
  since_ms: number | string;
  since_key: string;
}

/**
 * Listas de relacionamento **só da própria conta** (ADR 0004, história 3.6). Toda função recebe o
 * `AuthContext` (nunca um id vindo do cliente) e lista só as relações de `auth.userId`. Uma regra
 * de lint (`apps/api/eslint.config.mjs`) só deixa importar este arquivo no `OwnListsService`, que
 * só pode ser importado pelo `MeListsController` (CA5). Contas excluídas não aparecem (CA6).
 */
@Injectable()
export class OwnListsRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  /** Conexões de quem chama, das mais novas para as mais antigas (os dois lados do par). */
  async listMyConnections(auth: AuthContext, page: OwnListPageQuery): Promise<OwnListRow[]> {
    const me = auth.userId;
    return this.page(
      sql`(select c.user_b_id as other_id, c.created_at from connections c where c.user_a_id = ${me}
           union all
           select c.user_a_id, c.created_at from connections c where c.user_b_id = ${me}) r`,
      page,
    );
  }

  /** Criadores que quem chama segue, dos mais novos para os mais antigos. */
  async listMyFollowing(auth: AuthContext, page: OwnListPageQuery): Promise<OwnListRow[]> {
    return this.page(
      sql`(select f.creator_id as other_id, f.created_at from follows f
            where f.follower_id = ${auth.userId}) r`,
      page,
    );
  }

  /** Contas que quem chama bloqueou (X.2 CA4), das mais novas para as mais antigas. */
  async listMyBlocks(auth: AuthContext, page: OwnListPageQuery): Promise<OwnListRow[]> {
    return this.page(
      sql`(select b.blocked_id as other_id, b.created_at from blocks b
            where b.blocker_id = ${auth.userId}) r`,
      page,
    );
  }

  private async page(relations: SQL, page: OwnListPageQuery): Promise<OwnListRow[]> {
    const after =
      page.after === undefined
        ? sql``
        : sql`where (r.created_at, u.id) < (${page.after.at}::timestamptz, ${page.after.id}::uuid)`;
    const result = await this.database.db.execute(sql`
      select u.id, u.handle, u.name, u.avatar_key,
             floor(extract(epoch from r.created_at) * 1000)::bigint as since_ms,
             to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as since_key
        from ${relations}
        join users u on u.id = r.other_id and u.deleted_at is null
        ${after}
       order by r.created_at desc, u.id desc
       limit ${page.limit}
    `);
    return rowsOf<RawRow>(result).map((row) => ({
      id: row.id,
      handle: row.handle,
      name: row.name,
      avatarKey: row.avatar_key,
      since: new Date(Number(row.since_ms)),
      sinceKey: row.since_key,
    }));
  }
}
