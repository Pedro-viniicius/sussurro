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
 * Janela de moderação do pedido (ADR 0013, no lugar da exceção R1-5 do encosto): as duas pessoas de
 * um pedido de conexão criado há até 24 h (qualquer direção, qualquer status) podem se bloquear e
 * denunciar a conta uma da outra pelo @, mesmo sem ver o perfil. Assim quem recebe o pedido de um
 * desconhecido (que leu o QR ou o NFC, até de longe) pode bloquear e denunciar, não só recusar.
 * Contada a partir de `created_at` do pedido, no Postgres (sem Valkey).
 */
export const CONNECTION_REQUEST_MODERATION_WINDOW_S = 24 * 60 * 60;

/**
 * Como o código foi lido (D3, ADR 0013 §2), gravado no pedido e na conexão (PROX-22): `qr` = QR code
 * ou `nfc` = encostando os celulares (NFC). As regras são as mesmas para os dois. Registros antigos
 * com `ble` (ADR 0012, histórico no banco) saem como `nfc` nas respostas.
 */
export const ConnectionMethodSchema = z.enum(['qr', 'nfc'], {
  error: 'Use "qr" ou "nfc".',
});
export type ConnectionMethod = z.infer<typeof ConnectionMethodSchema>;

/**
 * `POST /connections/requests` (A → B, e-mail confirmado, tela de A aberta). `targetToken`: o token
 * de B lido por QR ou NFC, válido (até 30 s); `method`: o caminho da leitura (ADR 0013 §2). Vencido,
 * inexistente ou do próprio chamador → 400 `PROXIMITY_TOKEN_INVALID`.
 */
export const CreateConnectionRequestSchema = z.strictObject({
  targetToken: ProximityTokenValueSchema,
  method: ConnectionMethodSchema,
});
export type CreateConnectionRequest = z.infer<typeof CreateConnectionRequestSchema>;

/**
 * `POST /connections/requests/:id/accept` (B, e-mail confirmado, tela aberta). `observedToken` (D7,
 * leitura cruzada; ADR 0013 §2): **obrigatório** nos dois métodos, o token de A lido por B (QR ou
 * NFC) na tela "Aguardando" de A, até 120 s. Sem ele → 400 `VALIDATION_ERROR`; vencido ou de outra
 * pessoa → 400 `PROXIMITY_TOKEN_INVALID`, e o pedido continua pendente.
 */
export const AcceptConnectionRequestSchema = z.strictObject({
  observedToken: ProximityTokenValueSchema,
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
 * uma persona do seed (`@lucasf` por padrão, ou `@tomas`) pede conexão para a conta logada, pelo
 * método `qr` (o padrão) ou `nfc`.
 */
export const SimulateConnectionRequestSchema = z.strictObject({
  from: z.string().min(1).max(64).optional(),
  method: ConnectionMethodSchema.optional(),
});
export type SimulateConnectionRequest = z.infer<typeof SimulateConnectionRequestSchema>;

/**
 * Resposta da simulação: o pedido como a conta logada o vê e o token válido da persona, que o app de
 * desenvolvimento usa como `observedToken` no aceite (não há um segundo aparelho mostrando o código).
 */
export const SimulatedConnectionRequestSchema = z.object({
  request: ConnectionRequestSchema,
  observedToken: ProximityTokenValueSchema,
});
export type SimulatedConnectionRequest = z.infer<typeof SimulatedConnectionRequestSchema>;
