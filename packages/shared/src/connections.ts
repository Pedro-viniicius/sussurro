import { z } from 'zod';

import { ProximityTokenValueSchema } from './proximity.ts';

// Pedidos de conexão presencial e desfazer conexão (ADR 0003, histórias 4.5, 4.6, 4.9 e 4.11).

const isoDate = z.iso.datetime();

/** Validade de um pedido pendente (ADR 0003). O app mostra "Expira em 1:45" com `expiresInS`. */
export const CONNECTION_REQUEST_TTL_S = 120;
/** Polling com a tela Conectar aberta: `incoming` (B) e `GET .../:id` (A), a cada 2 s. */
export const CONNECTION_POLL_INTERVAL_S = 2;
/** Depois de uma recusa, A não consegue pedir de novo para B por 1 h (B → A continua livre, A-34). */
export const CONNECTION_DECLINE_COOLDOWN_S = 60 * 60;

/**
 * Como a conexão foi feita (D3), gravado no pedido e na conexão (PROX-22): `ble` = encostando os
 * celulares (ADR 0012, P11; sem valor novo) ou `qr` = QR code.
 */
export const ConnectionMethodSchema = z.enum(['ble', 'qr'], {
  error: 'Use "ble" ou "qr".',
});
export type ConnectionMethod = z.infer<typeof ConnectionMethodSchema>;

/**
 * `POST /connections/requests` (A → B, e-mail confirmado, tela de A aberta). `targetToken`, pelo
 * método (ADR 0012 §4):
 * - `ble`: o `bleToken` de B devolvido no cartão do encosto (`touches`), válido ou recente (até
 *   120 s). Exige o par encostado A–B (60 s desde o casamento);
 * - `qr`: o `qrToken` lido do QR de B, válido (até 30 s).
 * Sem o par, token do outro canal, vencido ou de outra pessoa → 400 `PROXIMITY_TOKEN_INVALID`.
 */
export const CreateConnectionRequestSchema = z.strictObject({
  targetToken: ProximityTokenValueSchema,
  method: ConnectionMethodSchema,
});
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequestSchema>;

/**
 * `POST /connections/requests/:id/accept` (B, e-mail confirmado, tela aberta). `observedToken`, pelo
 * método do pedido (ADR 0012 §4):
 * - `ble`: dispensado (se vier, é ignorado). O pedido só nasce com o par encostado;
 * - `qr` (D7, QR cruzado): **obrigatório**, o `qrToken` lido do QR de A na tela "Aguardando" (até
 *   120 s). Sem ele → 400 `VALIDATION_ERROR`; do outro canal, vencido ou de outra pessoa → 400
 *   `PROXIMITY_TOKEN_INVALID`, e o pedido continua pendente.
 */
export const AcceptConnectionRequestSchema = z.strictObject({
  observedToken: ProximityTokenValueSchema.optional(),
});
export type AcceptConnectionRequest = z.infer<typeof AcceptConnectionRequestSchema>;

/** `:id` dos pedidos: uuid; qualquer outra coisa → 400. */
export const ConnectionRequestIdSchema = z.uuid({ error: 'Identificador inválido.' });

/**
 * Estado do pedido para quem chama:
 * - quem pediu (`outgoing`) vê só `pending`, `accepted` ou `not_confirmed` (recusado, vencido ou
 *   cancelado, sem diferença: a recusa nunca é revelada, ux.md §5.2);
 * - quem recebeu (`incoming`) vê `pending`, `accepted`, `declined`, `expired` ou `cancelled`.
 */
export const ConnectionRequestStatusSchema = z.enum([
  'pending',
  'accepted',
  'not_confirmed',
  'declined',
  'expired',
  'cancelled',
]);
export type ConnectionRequestStatus = z.infer<typeof ConnectionRequestStatusSchema>;

/** A outra pessoa do pedido (para B, quem pediu; para A, a quem pediu). */
export const ConnectionRequestPartySchema = z.object({
  handle: z.string(),
  name: z.string(),
  avatarUrl: z.url().nullable(),
});
export type ConnectionRequestParty = z.infer<typeof ConnectionRequestPartySchema>;

/**
 * Um pedido de conexão, visto por uma das duas pessoas. Terceiros nunca o veem (404, PROX-12).
 * `expiresInS`: segundos até vencer pelo relógio do servidor (0 quando não está pendente).
 */
export const ConnectionRequestSchema = z.object({
  id: z.uuid(),
  direction: z.enum(['outgoing', 'incoming']),
  status: ConnectionRequestStatusSchema,
  method: ConnectionMethodSchema,
  other: ConnectionRequestPartySchema,
  createdAt: isoDate,
  expiresAt: isoDate,
  expiresInS: z.int().min(0),
});
export type ConnectionRequest = z.infer<typeof ConnectionRequestSchema>;

/**
 * `GET /connections/requests/incoming`: os pedidos pendentes **para quem chama**, do mais antigo
 * para o mais novo (as folhas aparecem uma por vez, 4.6 CA10). No máximo 20. Nunca há rota que
 * liste pedidos de outra conta.
 */
export const IncomingConnectionRequestsSchema = z.object({
  items: z.array(ConnectionRequestSchema),
});
export type IncomingConnectionRequests = z.infer<typeof IncomingConnectionRequestsSchema>;

// --- simulação em desenvolvimento (história 4.11, D15) ------------------------------------------

/**
 * `POST /dev/simulate-request` (só com `NODE_ENV=development`; em produção a rota não existe):
 * uma persona do seed (`@lucasf` por padrão, ou `@tomas`) pede conexão para a conta logada. No
 * método `ble` (o padrão), o servidor também grava o par encostado da persona com a conta.
 */
export const SimulateConnectionRequestSchema = z.strictObject({
  from: z.string().min(1).max(64).optional(),
  method: ConnectionMethodSchema.optional(),
});
export type SimulateConnectionRequest = z.infer<typeof SimulateConnectionRequestSchema>;

/**
 * Resposta da simulação: o pedido como a conta logada o vê e o `qrToken` válido da persona (ADR
 * 0012), que o app de desenvolvimento usa como `observedToken` no aceite de um pedido `qr` (não há
 * um segundo aparelho mostrando o QR). O aceite `ble` dispensa o token.
 */
export const SimulatedConnectionRequestSchema = z.object({
  request: ConnectionRequestSchema,
  observedToken: ProximityTokenValueSchema,
});
export type SimulatedConnectionRequest = z.infer<typeof SimulatedConnectionRequestSchema>;
