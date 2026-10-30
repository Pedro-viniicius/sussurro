import { Inject, Injectable } from '@nestjs/common';
import { and, type DbHandle, eq, inArray, isNull, type SQL, sql, users } from '@sussurro/db';

import { DATABASE } from '../../infra/database/database.providers.js';

/** Dono de um token resolvido, com o que o cartão "Por perto" mostra. */
export interface NearbyRow {
  id: string;
  handle: string;
  name: string;
  avatarKey: string | null;
  connected: boolean;
}

/**
 * Leitura das contas por trás dos tokens resolvidos (arquitetura.md §5: a proximidade não grava no
 * Postgres). Só contas pessoais ativas; `visible` é o filtro de bloqueio da política (X.2).
 */
@Injectable()
export class ProximityRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  async findNearby(viewerId: string, ids: readonly string[], visible: SQL): Promise<NearbyRow[]> {
    if (ids.length === 0) {
      return [];
    }
    return this.database.db
      .select({
        id: users.id,
        handle: users.handle,
        name: users.name,
        avatarKey: users.avatarKey,
        connected: sql<boolean>`exists (
          select 1 from connections c
           where (c.user_a_id = ${viewerId} and c.user_b_id = ${users.id})
              or (c.user_b_id = ${viewerId} and c.user_a_id = ${users.id}))`,
      })
      .from(users)
      .where(
        and(
          inArray(users.id, [...ids]),
          eq(users.accountType, 'personal'),
          isNull(users.deletedAt),
          visible,
        ),
      );
  }
}
