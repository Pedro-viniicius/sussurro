import { Inject, Injectable } from '@nestjs/common';
import { type DbHandle, type NewReportRow, reports } from '@sussurro/db';

import { DATABASE } from '../../infra/database/database.providers.js';

/** Denúncias (X.1). Não há leitura pela API: a fila de moderação é o e-mail (sem painel na v1). */
@Injectable()
export class ReportsRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  /**
   * Grava a denúncia. Se a mesma pessoa já denunciou o mesmo alvo, nada muda e devolve
   * `undefined` (idempotência pelos índices únicos `reports_*_key`).
   */
  async insert(values: NewReportRow): Promise<string | undefined> {
    const [row] = await this.database.db
      .insert(reports)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: reports.id });
    return row?.id;
  }
}
