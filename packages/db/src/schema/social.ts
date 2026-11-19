import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { accountType, users } from './users.ts';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Como a conexão presencial foi feita (Fase 4). `ble` fica só como histórico (ADR 0013): tirar um
 * valor de enum exige recriar o tipo (migration destrutiva). Nenhuma escrita nova usa `ble`; na
 * leitura, o servidor mostra o `ble` antigo como `nfc`.
 */
export const connectionMethod = pgEnum('connection_method', ['ble', 'qr', 'nfc']);

/**
 * Ciclo do pedido de conexão (ADR 0003). `pending` vale até `expires_at` (120 s); a expiração é
 * preguiçosa (cada operação do par marca os vencidos) e o job do worker marca o resto.
 */
export const requestStatus = pgEnum('request_status', [
  'pending',
  'accepted',
  'declined',
  'cancelled',
  'expired',
]);

/**
 * Pedidos de conexão presencial (Fase 4, ADR 0003 e 0008). Só entre contas pessoais (FKs
 * compostas com `*_type = 'personal'`), nunca a si mesmo, e no máximo **um** pendente por par, em
 * qualquer direção (índice único parcial sobre o par sem ordem). Quem recusou cria um intervalo de
 * 1 h para novo pedido do mesmo remetente, contado a partir de `responded_at` da linha `declined`.
 *
 * Retenção: o job do worker apaga as linhas que não estão pendentes depois de 30 dias; a conta
 * apagada de vez leva as linhas em cascata.
 */
export const connectionRequests = pgTable(
  'connection_requests',
  {
    id: uuid('id')
      .primaryKey()
      .default(sql`uuidv7()`),
    fromId: uuid('from_id').notNull(),
    fromType: accountType('from_type').notNull().default('personal'),
    toId: uuid('to_id').notNull(),
    toType: accountType('to_type').notNull().default('personal'),
    status: requestStatus('status').notNull().default('pending'),
    /** Método do pedido; a conexão nasce com o método do pedido aceito (PROX-22). */
    method: connectionMethod('method').notNull(),
    createdAt: timestamptz('created_at').notNull(),
    /** `created_at` + 120 s (gravado pela API com o `Clock`, A-27). */
    expiresAt: timestamptz('expires_at').notNull(),
    /** Quando o pedido deixou de estar pendente (aceito, recusado, cancelado ou vencido). */
    respondedAt: timestamptz('responded_at'),
  },
  (t) => [
    // No máximo um pendente por par, em qualquer direção (corrida A→B ∥ B→A, PROX-13 e PROX-16).
    uniqueIndex('connection_requests_pending_pair_key')
      .on(sql`least(from_id, to_id)`, sql`greatest(from_id, to_id)`)
      .where(sql`status = 'pending'`),
    // Caixa de entrada (polling de 2 s) e o ON DELETE CASCADE de `to_id`.
    index('connection_requests_to_idx').on(t.toId, t.status, t.createdAt),
    // Intervalo depois da recusa (from → to), invalidação no logout e o cascade de `from_id`.
    index('connection_requests_from_idx').on(t.fromId, t.toId),
    // Retenção de 30 dias (job do worker).
    index('connection_requests_created_idx').on(t.createdAt),
    foreignKey({
      name: 'connection_requests_from_fk',
      columns: [t.fromId, t.fromType],
      foreignColumns: [users.id, users.accountType],
    }).onDelete('cascade'),
    foreignKey({
      name: 'connection_requests_to_fk',
      columns: [t.toId, t.toType],
      foreignColumns: [users.id, users.accountType],
    }).onDelete('cascade'),
    check('connection_requests_not_self_chk', sql`from_id <> to_id`),
    check('connection_requests_from_personal_chk', sql`from_type = 'personal'`),
    check('connection_requests_to_personal_chk', sql`to_type = 'personal'`),
    check('connection_requests_expiry_chk', sql`expires_at > created_at`),
    check('connection_requests_responded_chk', sql`(status = 'pending') = (responded_at is null)`),
  ],
);

/**
 * Conexões entre contas pessoais, como par ordenado (`user_a_id < user_b_id`, arquitetura.md §6).
 * As FKs compostas com `*_type = 'personal'` garantem no banco que criador não se conecta (ADR
 * 0008). Fase 2: só o schema, as factories e o seed (o feed e a política de acesso dependem dela).
 * Fase 4: as rotas (`connections` na API) e a FK de `request_id` para `connection_requests` (a
 * retenção de 30 dias dos pedidos deixa `request_id` nulo).
 */
export const connections = pgTable(
  'connections',
  {
    userAId: uuid('user_a_id').notNull(),
    userAType: accountType('user_a_type').notNull().default('personal'),
    userBId: uuid('user_b_id').notNull(),
    userBType: accountType('user_b_type').notNull().default('personal'),
    method: connectionMethod('method').notNull(),
    /** Pedido que originou a conexão (rastreabilidade; nulo depois da retenção do pedido). */
    requestId: uuid('request_id'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'connections_pkey', columns: [t.userAId, t.userBId] }),
    // Busca pelo outro lado do par (CTE do feed, contadores).
    index('connections_user_b_idx').on(t.userBId, t.userAId),
    // O `ON DELETE SET NULL` quando a retenção apaga o pedido.
    index('connections_request_idx')
      .on(t.requestId)
      .where(sql`request_id is not null`),
    foreignKey({
      name: 'connections_request_fk',
      columns: [t.requestId],
      foreignColumns: [connectionRequests.id],
    }).onDelete('set null'),
    foreignKey({
      name: 'connections_user_a_fk',
      columns: [t.userAId, t.userAType],
      foreignColumns: [users.id, users.accountType],
    }).onDelete('cascade'),
    foreignKey({
      name: 'connections_user_b_fk',
      columns: [t.userBId, t.userBType],
      foreignColumns: [users.id, users.accountType],
    }).onDelete('cascade'),
    check('connections_ordered_pair_chk', sql`user_a_id < user_b_id`),
    check('connections_user_a_personal_chk', sql`user_a_type = 'personal'`),
    check('connections_user_b_personal_chk', sql`user_b_type = 'personal'`),
  ],
);

/**
 * Pessoa (pessoal) segue criador (arquitetura.md §6, ADR 0008). Fase 2: só o schema, as factories
 * e o seed; seguir e deixar de seguir (`PUT/DELETE /creators/:handle/follow`) chegam na Fase 3.
 */
export const follows = pgTable(
  'follows',
  {
    followerId: uuid('follower_id').notNull(),
    followerType: accountType('follower_type').notNull().default('personal'),
    creatorId: uuid('creator_id').notNull(),
    creatorType: accountType('creator_type').notNull().default('creator'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    // Também lista os seguidos e conta "criadores" de quem segue.
    primaryKey({ name: 'follows_pkey', columns: [t.followerId, t.creatorId] }),
    // Conta seguidores do criador.
    index('follows_creator_idx').on(t.creatorId),
    foreignKey({
      name: 'follows_follower_fk',
      columns: [t.followerId, t.followerType],
      foreignColumns: [users.id, users.accountType],
    }).onDelete('cascade'),
    foreignKey({
      name: 'follows_creator_fk',
      columns: [t.creatorId, t.creatorType],
      foreignColumns: [users.id, users.accountType],
    }).onDelete('cascade'),
    check('follows_follower_personal_chk', sql`follower_type = 'personal'`),
    check('follows_creator_creator_chk', sql`creator_type = 'creator'`),
  ],
);

/**
 * Bloqueios (X.2, D5; Fase 3). Vale para qualquer tipo de conta e nos dois sentidos para a
 * visibilidade: quem bloqueia e quem é bloqueado deixam de se ver (perfil, posts, comentários e
 * busca), decidido só pelo `AccessPolicyService`. Bloquear desfaz a conexão e os follows do par na
 * mesma transação. A lista de bloqueados só sai para o dono (`GET /me/blocks`, ADR 0004).
 */
export const blocks = pgTable(
  'blocks',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    // Lista do dono e "A bloqueou B?".
    primaryKey({ name: 'blocks_pkey', columns: [t.blockerId, t.blockedId] }),
    // "B foi bloqueado por A?" (o outro sentido) e o ON DELETE CASCADE de users.
    index('blocks_blocked_idx').on(t.blockedId, t.blockerId),
    check('blocks_not_self_chk', sql`blocker_id <> blocked_id`),
  ],
);

export type ConnectionRow = typeof connections.$inferSelect;
export type ConnectionRequestRow = typeof connectionRequests.$inferSelect;
export type RequestStatusValue = (typeof requestStatus.enumValues)[number];
export type ConnectionMethodValue = (typeof connectionMethod.enumValues)[number];
export type FollowRow = typeof follows.$inferSelect;
export type BlockRow = typeof blocks.$inferSelect;
