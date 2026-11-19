import { z } from 'zod';

// Conexão presencial: tokens de proximidade, `resolve` e o código `sussurro://c/{token}`, que o app
// mostra por QR code e emite por NFC (ADR 0003, Fase 4; ADR 0013, "Conectar por NFC e QR"). Os
// tempos abaixo são os padrões do servidor (configuráveis por env na API, A-27); a resposta de `POST /proximity/tokens`
// traz os valores em vigor.

const isoDate = z.iso.datetime();

/** 12 bytes de CSPRNG por token (96 bits, ADR 0002). */
export const PROXIMITY_TOKEN_BYTES = 12;
/** 12 bytes em base64url sem padding = 16 caracteres. */
export const PROXIMITY_TOKEN_LENGTH = 16;
/** Validade do token para ser resolvido e iniciar pedido (`prox:t`). */
export const PROXIMITY_TOKEN_TTL_S = 30;
/**
 * Janela "recente" (`prox:r`): até 120 s depois de emitido, o token ainda confirma o aceite (leitura
 * cruzada, D7), pelo QR ou pelo NFC (ADR 0013 §2).
 */
export const PROXIMITY_RECENT_TTL_S = 120;
/** O app renova o token (o QR e o NFC) a cada 20 s com a tela Conectar aberta. */
export const PROXIMITY_RENEW_INTERVAL_S = 20;
/** Tokens por chamada de `POST /proximity/resolve` (PROX-05). */
export const PROXIMITY_RESOLVE_MAX_TOKENS = 20;
/**
 * Intervalo mínimo sugerido entre duas chamadas de `resolve` (A-17). O app chama uma vez por código
 * lido (QR ou NFC).
 */
export const PROXIMITY_RESOLVE_MIN_INTERVAL_S = 3;

/** Token de proximidade: 16 caracteres base64url (`A-Z a-z 0-9 - _`). */
export const ProximityTokenValueSchema = z
  .string({ error: 'Código de proximidade inválido.' })
  .regex(/^[A-Za-z0-9_-]{16}$/, { error: 'Código de proximidade inválido.' });
export type ProximityTokenValue = z.infer<typeof ProximityTokenValueSchema>;

/**
 * Resposta de `POST /proximity/tokens` (só conta pessoal com e-mail confirmado). Cada chamada marca
 * a tela Conectar como aberta por 30 s. `renewInS`: quando pedir os próximos (o app não espera os
 * tokens vencerem, PROX-25). `expiresAt` é o horário do servidor; para contar o tempo, use
 * `renewInS`.
 *
 * (ADR 0013 §1) Um token só por emissão: o mesmo conteúdo (`sussurro://c/{token}`) vai no QR, como
 * texto, e no NFC, como registro NDEF URI.
 */
export const ProximityTokenSchema = z.object({
  token: ProximityTokenValueSchema,
  expiresAt: isoDate,
  renewInS: z.int().min(1),
});
export type ProximityToken = z.infer<typeof ProximityTokenSchema>;

/**
 * `POST /proximity/resolve`: o app manda o token lido do QR ou do NFC (de 1 a 20 por chamada;
 * repetidos são ignorados). Sem campo a mais: nada de dado do aparelho (PROX-05).
 */
export const ProximityResolveRequestSchema = z.strictObject({
  tokens: z
    .array(ProximityTokenValueSchema)
    .min(1, { error: 'Envie pelo menos um código.' })
    .max(PROXIMITY_RESOLVE_MAX_TOKENS, {
      error: `Envie no máximo ${PROXIMITY_RESOLVE_MAX_TOKENS} códigos.`,
    }),
});
export type ProximityResolveRequest = z.infer<typeof ProximityResolveRequestSchema>;

/**
 * O cartão de uma pessoa cujo código foi lido (`resolve`). `token`: o
 * token dela que o app enviou (o mais recente, se vieram vários); é o `targetToken` do pedido.
 * `alreadyConnected`: o app mostra "Conectados" no lugar do botão (4.4 CA4).
 */
export const NearbyPersonSchema = z.object({
  token: ProximityTokenValueSchema,
  handle: z.string(),
  name: z.string(),
  avatarUrl: z.url().nullable(),
  alreadyConnected: z.boolean(),
});
export type NearbyPerson = z.infer<typeof NearbyPersonSchema>;

/**
 * Resposta de `resolve`: uma linha por pessoa, na ordem do primeiro token dela no pedido. Tokens
 * inválidos, vencidos, do próprio chamador, de conta excluída ou com bloqueio em
 * qualquer sentido simplesmente não aparecem (PROX-05).
 */
export const ProximityResolveResultSchema = z.object({
  items: z.array(NearbyPersonSchema),
});
export type ProximityResolveResult = z.infer<typeof ProximityResolveResultSchema>;

// --- Código do QR e do NFC (D3, D7, ADR 0013 §1) ------------------------------------------------

/**
 * Conteúdo do código: `sussurro://c/{token}`. O mesmo nos dois transportes: texto no QR e registro
 * NDEF URI no NFC.
 */
export const PROXIMITY_QR_PREFIX = 'sussurro://c/';

/** Conteúdo do código (QR ou NFC) para o token da emissão. */
export function proximityQrPayload(token: string): string {
  return `${PROXIMITY_QR_PREFIX}${token}`;
}

/**
 * Token de um código lido pela câmera, pelo NFC ou do deep link. Qualquer outro conteúdo, prefixo diferente
 * ou token mal formado → `null` (o app mostra a mensagem amigável sem chamar a API, 4.7 CA4).
 */
export function parseProximityQr(text: string): string | null {
  const value = text.trim();
  if (!value.startsWith(PROXIMITY_QR_PREFIX)) {
    return null;
  }
  const token = value.slice(PROXIMITY_QR_PREFIX.length);
  return ProximityTokenValueSchema.safeParse(token).success ? token : null;
}
