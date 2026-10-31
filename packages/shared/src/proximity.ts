import { z } from 'zod';

// Conexão presencial: tokens de proximidade, encostar (`touches`), `resolve` do QR, QR e o UUID do
// anúncio BLE (ADR 0002 e 0003, Fase 4; ADR 0012, "Conectar encostando"). Os tempos abaixo são os
// padrões do servidor (configuráveis por env na API, A-27); a resposta de `POST /proximity/tokens`
// traz os valores em vigor.

const isoDate = z.iso.datetime();

/** 12 bytes de CSPRNG por token (96 bits, ADR 0002). */
export const PROXIMITY_TOKEN_BYTES = 12;
/** 12 bytes em base64url sem padding = 16 caracteres. */
export const PROXIMITY_TOKEN_LENGTH = 16;
/** Validade do token para iniciar pedido, ser relatado no encosto e ser resolvido (`prox:t`). */
export const PROXIMITY_TOKEN_TTL_S = 30;
/**
 * Janela "recente" (`prox:r`): até 120 s depois de emitido, o token ainda confirma o aceite `qr` e
 * identifica o alvo do pedido `ble` com o par encostado (ADR 0012 §4).
 */
export const PROXIMITY_RECENT_TTL_S = 120;
/** O app renova os tokens (o anúncio e o QR) a cada 20 s com a tela Conectar aberta. */
export const PROXIMITY_RENEW_INTERVAL_S = 20;
/** Tokens por chamada de `POST /proximity/resolve` (PROX-05). */
export const PROXIMITY_RESOLVE_MAX_TOKENS = 20;
/**
 * Intervalo mínimo sugerido entre duas chamadas de `resolve` (A-17). (ADR 0012) O `resolve` serve só
 * ao QR: o app chama uma vez por código lido.
 */
export const PROXIMITY_RESOLVE_MIN_INTERVAL_S = 3;

// --- Encostar (ADR 0012 §3 e Adendo A2) ----------------------------------------------------------

/**
 * Tokens por chamada de `POST /proximity/touches`: exatamente 1, o de menor perda (ADR 0012, A2-1).
 * "Uma pessoa por vez" (P8) é regra do servidor: cada chamada cria no máximo um par.
 */
export const PROXIMITY_TOUCH_MAX_TOKENS = 1;
/**
 * Janela do casamento (A2-2): o relato de um aparelho só casa com a observação do outro se o
 * **primeiro** relato do outro sobre ele tem menos de 5 s. (A2 rev. 1, R1-1) A observação (`prox:o`)
 * guarda o horário desse primeiro relato enquanto o observador continuar relatando: cada relato a
 * regrava por mais o dobro da janela (10 s, prazo deslizante), e ela só some depois de 10 s sem
 * relato. Padrão do `PROX_TOUCH_WINDOW_S` da API.
 */
export const PROXIMITY_TOUCH_WINDOW_S = 5;
/**
 * Quanto tempo o par encostado (`prox:m`) vale para **pedir** a conexão por encostar, contado do
 * casamento no servidor, e quanto tempo o cartão devido espera a entrega (A2-2). O app tira o
 * cartão 5 s antes. Padrão do `PROX_TOUCH_PAIR_TTL_S` da API.
 */
export const PROXIMITY_TOUCH_PAIR_TTL_S = 60;
/** O app relata o encosto a cada 1 s, sem sobrepor. */
export const PROXIMITY_TOUCH_REPORT_INTERVAL_S = 1;
/**
 * Por quanto tempo o app relata depois de cada encosto admitido e da **resposta** de cada relato de
 * token novo (A2-2; A2 rev. 1, R1-2 e R1-3), mesmo que os celulares já tenham se afastado; para
 * quando recebe o cartão. É a metade do app no invariante: toda janela que o servidor abre sobre
 * quem foi visto é seguida de relatos dele por pelo menos 8 s, e 8 ≥ janela (5) + 2 s de latência.
 * Então quem foi visto sempre relata de novo depois do último casamento possível e recebe o cartão
 * de quem o viu. A API não sobe com `PROX_TOUCH_WINDOW_S + 2` acima deste valor.
 */
export const PROXIMITY_TOUCH_REPORT_FOR_S = 8;
/**
 * Limite de relatos (`POST /proximity/touches`) por conta e por minuto no servidor; o 61º dá 429,
 * salvo na primeira entrega de um cartão devido (ela sai antes de qualquer recusa, A2 rev. 1, R1-4).
 * (ADR 0012, A3-2) A reentrega do mesmo cartão, por até 10 s depois da primeira entrega, conta no
 * limite. O app fica abaixo disso (ADR 0012, A3-8, item 1): no pior caso, 51 inícios por admissão
 * sem alternância, e até 56 em 60 s com uma rede que alterna (cada 200 que encerra uma sequência
 * de falhas depois de ≥ 5 s sem aceite estende o prazo de novo). A folga de 4 cobre a janela fixa
 * do servidor e a latência, e o app não recebe 429 dos próprios relatos (PROX-68).
 */
export const PROXIMITY_TOUCH_LIMIT_PER_MIN = 60;

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
 * (ADR 0012 §1) Cada emissão traz **dois tokens distintos**, um por canal, com a mesma validade:
 * - `bleToken`: só vai no anúncio Bluetooth (UUID de serviço) e nunca é resolvido sozinho; vira
 *   pessoa apenas no encosto mútuo (`touches`);
 * - `qrToken`: só aparece na tela, no QR (`sussurro://c/{qrToken}`), e nunca vai ao ar.
 * O servidor recusa o token de um canal usado no outro.
 */
export const ProximityTokenSchema = z.object({
  bleToken: ProximityTokenValueSchema,
  qrToken: ProximityTokenValueSchema,
  expiresAt: isoDate,
  renewInS: z.int().min(1),
});
export type ProximityToken = z.infer<typeof ProximityTokenSchema>;

/**
 * `POST /proximity/resolve`: (ADR 0012) só o QR. O app manda o `qrToken` lido do QR (de 1 a 20 por
 * chamada; repetidos são ignorados). Um `bleToken` não resolve: a resposta é a de token inexistente
 * (PROX-05). Sem campo a mais: nada de RSSI nem de dado do aparelho.
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
 * O cartão de uma pessoa: a do encosto mútuo (`touches`) ou a do QR lido (`resolve`). `token`: o
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
 * inválidos, vencidos, do Bluetooth, do próprio chamador, de conta excluída ou com bloqueio em
 * qualquer sentido simplesmente não aparecem (PROX-05).
 */
export const ProximityResolveResultSchema = z.object({
  items: z.array(NearbyPersonSchema),
});
export type ProximityResolveResult = z.infer<typeof ProximityResolveResultSchema>;

/**
 * `POST /proximity/touches` (ADR 0012 §3): o app afirma que o celular encostou no do dono do token,
 * já no limiar de "encostado" medido no aparelho. É o `bleToken` visto no anúncio, **exatamente 1**
 * por chamada (A2-1; continua uma lista). **Sem campo a mais:** o RSSI, a potência e o modelo do
 * aparelho nunca saem do aparelho, e o schema recusa qualquer outra chave (PROX-38, PROX-43).
 */
export const ProximityTouchRequestSchema = z.strictObject({
  tokens: z
    .array(ProximityTokenValueSchema)
    .min(1, { error: 'Envie um código.' })
    .max(PROXIMITY_TOUCH_MAX_TOKENS, {
      error: `Envie no máximo ${PROXIMITY_TOUCH_MAX_TOKENS} código.`,
    }),
});
export type ProximityTouchRequest = z.infer<typeof ProximityTouchRequestSchema>;

/**
 * Um cartão do encosto (`touches`): o `NearbyPerson` e (ADR 0012, A2 rev. 1, R1-9)
 * `pairExpiresInS`, quantos segundos faltam para o par encostado vencer no servidor, **arredondados
 * para baixo num múltiplo de 5** (entre 0 e a validade do par menos 5; A3-5: no máximo 55 com a
 * validade de 60 s, mesmo com o relógio de outra instância da API). Enquanto o par vale, o cartão
 * pode pedir a conexão, bloquear e denunciar pelo @; o app conta o prazo do cartão por este campo, e
 * não pela chegada da resposta (um cartão devido pode chegar tarde). A conta é a mesma para o
 * casamento na hora, para o cartão devido e para a reentrega dele (A3-2), a partir do horário do
 * casamento: com o degrau de 5 s, os dois primeiros dão o mesmo valor (55 com a validade de 60 s), e
 * o campo não revela quem casou primeiro (PROX-37). O cartão pode vencer no app até 5 s antes do
 * par, o que a margem do app já cobre.
 */
export const ProximityTouchItemSchema = NearbyPersonSchema.extend({
  pairExpiresInS: z.int().min(0),
});
export type ProximityTouchItem = z.infer<typeof ProximityTouchItemSchema>;

/**
 * Resposta de `touches`, sempre 200, com **no máximo um** cartão (A2-2): o de quem também relatou o
 * encosto com quem chama na janela (**encosto mútuo**), ou o cartão que essa pessoa deixou guardado
 * para quem chama no casamento (entregue mesmo que ela tenha bloqueado, excluído a conta ou saído
 * depois). (ADR 0012, A3-2) Depois da primeira entrega, esse cartão fica guardado por mais até 10 s
 * e é entregue de novo, só a quem chama, a cada relato nesse tempo (se a resposta se perder na rede);
 * a reentrega conta no limite de relatos. Quem relata primeiro recebe `items: []` e, no relato
 * seguinte, o cartão (revelação simétrica). Token não mútuo, vencido, inexistente, do QR, do próprio
 * chamador, de criador, de conta excluída, com bloqueio, acima do teto de pessoas novas ou com
 * alguém ocupado é indistinguível: simplesmente não aparece (PROX-32, PROX-36, PROX-46). Cada cartão
 * traz `pairExpiresInS` (PROX-64).
 */
export const ProximityTouchResultSchema = z.object({
  items: z.array(ProximityTouchItemSchema),
});
export type ProximityTouchResult = z.infer<typeof ProximityTouchResultSchema>;

// --- simulação em desenvolvimento (D15, ADR 0012 §7) -----------------------------------------------

/**
 * `POST /dev/simulate-touch` (só com `NODE_ENV=development`; em produção a rota não existe, PROX-30):
 * uma persona do seed (`@lucasf` por padrão, ou `@tomas`) "encosta" na conta logada. O servidor grava
 * a observação da persona e devolve o `bleToken` dela; o app relata esse token em `touches` dentro
 * da janela (5 s) e recebe o cartão, como no encosto com um segundo aparelho.
 */
export const SimulateTouchRequestSchema = z.strictObject({
  from: z.string().min(1).max(64).optional(),
});
export type SimulateTouchRequest = z.infer<typeof SimulateTouchRequestSchema>;

/** Resposta da simulação do encosto: o `bleToken` válido da persona (30 s). */
export const SimulatedTouchSchema = z.object({
  bleToken: ProximityTokenValueSchema,
});
export type SimulatedTouch = z.infer<typeof SimulatedTouchSchema>;

// --- QR code (plano B, D3 e D7) -----------------------------------------------------------------

/**
 * Conteúdo do QR: `sussurro://c/{qrToken}`. (ADR 0012) É o `qrToken` da emissão, nunca o
 * `bleToken` do anúncio.
 */
export const PROXIMITY_QR_PREFIX = 'sussurro://c/';

/** Conteúdo do QR para o `qrToken` (o `bleToken` não serve: o servidor o recusa no QR). */
export function proximityQrPayload(qrToken: string): string {
  return `${PROXIMITY_QR_PREFIX}${qrToken}`;
}

/**
 * `qrToken` de um QR lido pela câmera (ou do deep link). Qualquer outro conteúdo, prefixo diferente
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
 * `53555353-xxxx-xxxx-xxxx-xxxxxxxxxxxx`. (ADR 0012) Só o `bleToken` vai ao ar. Token mal formado →
 * erro (é um bug do app).
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
