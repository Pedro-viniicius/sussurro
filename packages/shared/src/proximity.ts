import { z } from 'zod';

// Conexão presencial: tokens de proximidade, `resolve`, QR e o UUID do anúncio BLE (ADR 0002 e
// 0003, Fase 4). Os tempos abaixo são os padrões do servidor (configuráveis por env na API, A-27);
// a resposta de `POST /proximity/tokens` traz os valores em vigor.

const isoDate = z.iso.datetime();

/** 12 bytes de CSPRNG por token (96 bits, ADR 0002). */
export const PROXIMITY_TOKEN_BYTES = 12;
/** 12 bytes em base64url sem padding = 16 caracteres. */
export const PROXIMITY_TOKEN_LENGTH = 16;
/** Validade do token para iniciar pedido e ser resolvido (`prox:t`). */
export const PROXIMITY_TOKEN_TTL_S = 30;
/** Janela "recente": o token ainda confirma um aceite até 120 s depois de emitido (`prox:r`). */
export const PROXIMITY_RECENT_TTL_S = 120;
/** O app renova o token (e o anúncio e o QR) a cada 20 s com a tela Conectar aberta. */
export const PROXIMITY_RENEW_INTERVAL_S = 20;
/** Tokens por chamada de `POST /proximity/resolve` (PROX-05). */
export const PROXIMITY_RESOLVE_MAX_TOKENS = 20;
/**
 * Intervalo mínimo sugerido entre duas chamadas de `resolve` (A-17): o app junta numa chamada só os
 * tokens ainda não resolvidos. A cada 3 s são no máximo 20 chamadas por minuto, abaixo do limite de
 * 30 por minuto, com qualquer número de pessoas por perto.
 */
export const PROXIMITY_RESOLVE_MIN_INTERVAL_S = 3;

/** Token de proximidade: 16 caracteres base64url (`A-Z a-z 0-9 - _`). */
export const ProximityTokenValueSchema = z
  .string({ error: 'Código de proximidade inválido.' })
  .regex(/^[A-Za-z0-9_-]{16}$/, { error: 'Código de proximidade inválido.' });
export type ProximityTokenValue = z.infer<typeof ProximityTokenValueSchema>;

/**
 * Resposta de `POST /proximity/tokens` (só conta pessoal com e-mail confirmado). Cada chamada marca
 * a tela Conectar como aberta por 30 s. `renewInS`: quando pedir o próximo (o app não espera o
 * token vencer, PROX-25). `expiresAt` é o horário do servidor; para contar o tempo, use `renewInS`.
 */
export const ProximityTokenSchema = z.object({
  token: ProximityTokenValueSchema,
  expiresAt: isoDate,
  renewInS: z.int().min(1),
});
export type ProximityToken = z.infer<typeof ProximityTokenSchema>;

/**
 * `POST /proximity/resolve`: os tokens vistos por BLE (ou lidos de QR) que o app quer transformar
 * em pessoas, de 1 a 20 por chamada (repetidos são ignorados). Sem RSSI: a distância ("bem perto"
 * / "por perto", D13) é calculada só no aparelho, e o servidor não recebe a força do sinal.
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
 * Uma pessoa por perto. `token`: o token mais recente dela entre os enviados (o app usa esse no
 * pedido, PROX-25). `alreadyConnected`: o app mostra "Conectados" no lugar do botão (4.4 CA4).
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
 * Resposta de `resolve`: uma linha por pessoa, na ordem do primeiro token dela no pedido (o app
 * reordena pelo sinal). Tokens inválidos, vencidos, do próprio chamador, de conta excluída ou com
 * bloqueio em qualquer sentido simplesmente não aparecem (PROX-05).
 */
export const ProximityResolveResultSchema = z.object({
  items: z.array(NearbyPersonSchema),
});
export type ProximityResolveResult = z.infer<typeof ProximityResolveResultSchema>;

// --- QR code (plano B, D3 e D7) -----------------------------------------------------------------

/** Conteúdo do QR: `sussurro://c/{token}` (o mesmo token do anúncio BLE). */
export const PROXIMITY_QR_PREFIX = 'sussurro://c/';

export function proximityQrPayload(token: string): string {
  return `${PROXIMITY_QR_PREFIX}${token}`;
}

/**
 * Token de um QR lido pela câmera (ou do deep link). Qualquer outro conteúdo, prefixo diferente ou
 * token mal formado → `null` (o app mostra a mensagem amigável sem chamar a API, 4.7 CA4).
 */
export function parseProximityQr(text: string): string | null {
  const value = text.trim();
  if (!value.startsWith(PROXIMITY_QR_PREFIX)) {
    return null;
  }
  const token = value.slice(PROXIMITY_QR_PREFIX.length);
  return ProximityTokenValueSchema.safeParse(token).success ? token : null;
}

// --- UUID do anúncio BLE (ADR 0002) -------------------------------------------------------------

/**
 * Prefixo fixo de 4 bytes do UUID de serviço anunciado: `53 55 53 53` ("SUSS" em ASCII). O UUID de
 * 128 bits é o prefixo seguido dos 12 bytes do token; não há nome local nem outro dado no anúncio.
 */
export const BLE_SERVICE_UUID_PREFIX = '53555353';

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 12 bytes → 16 caracteres base64url (sem `Buffer`, para rodar no Hermes). */
function bytesToToken(bytes: readonly number[]): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    out +=
      BASE64URL.charAt((chunk >> 18) & 63) +
      BASE64URL.charAt((chunk >> 12) & 63) +
      BASE64URL.charAt((chunk >> 6) & 63) +
      BASE64URL.charAt(chunk & 63);
  }
  return out;
}

/** 16 caracteres base64url → 12 bytes. O token já foi validado pelo schema. */
function tokenToBytes(token: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < token.length; index += 4) {
    const chunk =
      (BASE64URL.indexOf(token.charAt(index)) << 18) |
      (BASE64URL.indexOf(token.charAt(index + 1)) << 12) |
      (BASE64URL.indexOf(token.charAt(index + 2)) << 6) |
      BASE64URL.indexOf(token.charAt(index + 3));
    bytes.push((chunk >> 16) & 255, (chunk >> 8) & 255, chunk & 255);
  }
  return bytes;
}

/**
 * UUID de serviço (formato canônico, minúsculo) que o aparelho anuncia para o token:
 * `53555353-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. Token mal formado → erro (é um bug do app).
 */
export function proximityTokenToServiceUuid(token: string): string {
  if (!ProximityTokenValueSchema.safeParse(token).success) {
    throw new Error('Token de proximidade mal formado.');
  }
  const hex =
    BLE_SERVICE_UUID_PREFIX +
    tokenToBytes(token)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Token contido num UUID de serviço visto na varredura. UUID de outro app (sem o prefixo), curto
 * (16 ou 32 bits) ou mal formado → `null`: a varredura ignora (4.3 CA6). Aceita maiúsculas e
 * minúsculas, com ou sem hífens.
 */
export function serviceUuidToProximityToken(uuid: string): string | null {
  const hex = uuid.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex) || !hex.startsWith(BLE_SERVICE_UUID_PREFIX)) {
    return null;
  }
  const bytes: number[] = [];
  for (let index = BLE_SERVICE_UUID_PREFIX.length; index < hex.length; index += 2) {
    bytes.push(Number.parseInt(hex.slice(index, index + 2), 16));
  }
  return bytesToToken(bytes);
}
