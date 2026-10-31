import type { Redis } from 'ioredis';

import type { Clock } from '../../common/clock/clock.js';
import { RATE_LIMIT_SCRIPT, type RateLimitHit } from '../../common/rate-limit/rate-limit.store.js';

/**
 * Canal do token (ADR 0012 §1): `ble` só vai no anúncio e nunca é resolvido sozinho; `qr` só
 * aparece na tela, no QR. Cada emissão grava um de cada.
 */
export type ProximityChannel = 'ble' | 'qr';

/** Dono, emissão e canal de um token de proximidade. O token em si nunca é guardado (só o hash). */
export interface ProximityTokenRecord {
  userId: string;
  /** Emissão em ms (relógio da API): escolhe o token mais recente de cada pessoa. */
  issuedAt: number;
  channel: ProximityChannel;
}

/** Validades do token (ADR 0003): válido 30 s, recente 120 s, tela aberta 30 s. */
export interface ProximityTtls {
  validMs: number;
  recentMs: number;
  screenMs: number;
}

/**
 * O cartão que quem casa deixa guardado para o outro lado (ADR 0012, A2-2): o que o `NearbyPerson`
 * mostra, como estava no momento do casamento. Com o cartão (e não só o id), a entrega não lê o
 * banco ignorando o bloqueio nem a exclusão: a política decide uma vez, no casamento.
 */
export interface TouchCard {
  /** Id de quem deixou o cartão (o dono do cartão). */
  subjectId: string;
  /** Horário do casamento (ms, relógio da API). */
  atMs: number;
  handle: string;
  name: string;
  avatarKey: string | null;
  /** `alreadyConnected` do momento do casamento. */
  connected: boolean;
}

/**
 * O cartão devido a quem chama, com o hash do token do dono que essa pessoa relatou por último
 * (a regra do rótulo, A2-2 passo 2).
 */
export interface OwedCard extends TouchCard {
  tokenHash: string;
}

/**
 * (ADR 0012, A3-2) O cartão devido retirado: `redelivered` = ele já tinha sido entregue antes (a
 * reentrega, por até 10 s depois da primeira entrega, que conta no limite do `touches`).
 */
export type DeliveredOwedCard = OwedCard & { redelivered: boolean };

/**
 * (A3-2) Marca do cartão devido já entregue, no começo do valor de `prox:v`: `"!{hash}|{json}"`.
 * Nunca aparece no hash (base64url).
 */
const REDELIVERY_MARK = '!';

/**
 * Resultado do casamento (A2-2): `created` (par novo, conta no teto), `renewed` (o par já existia),
 * `capped` (alguém no teto de pessoas novas), `busy` (alguém com cartão a receber ou que recebeu um
 * há menos de 10 s), `gone` (a observação do outro passou da janela) e (ADR 0012, A3-1) `refused`
 * (a política recusou: `callerCard` nulo). Só os dois primeiros casam.
 */
export type TouchClaim = 'created' | 'renewed' | 'capped' | 'busy' | 'gone' | 'refused';

const TOUCH_CLAIMS: readonly TouchClaim[] = [
  'created',
  'renewed',
  'capped',
  'busy',
  'gone',
  'refused',
];

/** Entrada do casamento (A2-2 §6). `callerCard` vira o cartão devido ao outro. */
export interface ClaimTouchPairInput {
  callerId: string;
  otherId: string;
  atMs: number;
  /** Validade do par e do cartão devido (60 s). */
  pairTtlMs: number;
  /** Janela do casamento, contada do primeiro relato do outro (5 s). */
  windowMs: number;
  /** Quanto tempo quem recebe um cartão fica ocupado (`2 × janela`, 10 s). */
  busyMs: number;
  /** Teto de pares novos por conta (A2-1): por hora e por dia. */
  perHour: number;
  perDay: number;
  /**
   * O cartão de quem chama, ou (ADR 0012, A3-1) `null` quando a política recusou o par (bloqueio em
   * qualquer sentido, conta excluída ou de criador): o script roda do mesmo jeito, para o tempo não
   * distinguir a recusa, e volta `refused` (ou `gone`, se a janela já passou).
   */
  callerCard: TouchCard | null;
}

/** Janelas fixas do teto de pessoas novas (A2-1): 1 h e 24 h desde o primeiro par novo. */
export const TOUCH_PAIRS_HOUR_MS = 3_600_000;
export const TOUCH_PAIRS_DAY_MS = 86_400_000;

/**
 * Chaves no Redis (arquitetura.md §6, atualizado na Fase 4 e pela ADR 0012). `hash` = SHA-256 do
 * token. Nenhuma chave guarda dado de sinal (RSSI, potência, modelo) nem token em claro.
 */
export const proximityKeys = {
  /** Token **válido** (`{uid, iat, ch}`): relato do encosto, pedido e `resolve` do QR. */
  valid: (hash: string) => `prox:t:${hash}`,
  /** Token **recente** (o mesmo registro): aceite `qr` e alvo do pedido `ble` com o par. */
  recent: (hash: string) => `prox:r:${hash}`,
  /** Tela Conectar aberta (o hash do último token). */
  screen: (userId: string) => `prox:u:${userId}`,
  /** Hashes emitidos pela conta nos últimos 120 s, para invalidar no logout e na exclusão. */
  issued: (userId: string) => `prox:ut:${userId}`,
  /** Proximidade bloqueada depois de 20 falhas de token em 10 min. */
  lock: (userId: string) => `prox:lock:${userId}`,
  /**
   * (ADR 0012, A2-2) O observador relatou um `bleToken` do dono com força de encosto:
   * `"{primeiroMs}:{hash}"`, o horário do **primeiro** relato (não muda enquanto a chave vive) e o
   * hash do token relatado por último. (A2 rev. 1, R1-1) Vive `2 × janela` (10 s) desde o
   * **último** relato: prazo deslizante, regravado a cada relato.
   */
  touch: (observerId: string, ownerId: string) => `prox:o:${observerId}:${ownerId}`,
  /**
   * (ADR 0012) Par com encosto mútuo e sem bloqueio: libera o pedido `ble` entre os dois por 60 s
   * e (A2 rev. 1, R1-5) bloquear e denunciar pelo @. A mesma chave nos dois sentidos (menor id
   * primeiro). O valor é o horário (ms) e, depois de um bloqueio entre os dois, os sentidos já
   * contados no sinal de abuso (R1-6): `"{horário}"` ou `"{horário}:{a|b|ab|ba}"`, em que `a` = o
   * menor id bloqueou o maior e `b` = o contrário. O casamento regrava só o horário.
   */
  pair: (first: string, second: string) =>
    first < second ? `prox:m:${first}:${second}` : `prox:m:${second}:${first}`,
  /**
   * (A2-2) O cartão devido à conta: `"{hash}|{json}"`, no máximo um, 60 s. (ADR 0012, A3-2) A
   * primeira entrega não o apaga: vira `"!{hash}|{json}"`, com o prazo encurtado para
   * `min(o que falta, 10 s)`, e é entregue de novo à mesma pessoa até vencer (a reentrega).
   */
  owed: (userId: string) => `prox:v:${userId}`,
  /**
   * (A2-2) A conta recebeu um cartão há pouco (ocupada): ninguém casa com ela; "1", 10 s. (A3-2)
   * Gravado só na primeira entrega; a reentrega não o renova.
   */
  busy: (userId: string) => `prox:c:${userId}`,
  /** (A2-1) Pares novos da conta na hora e no dia (só o contador). */
  pairsPerHour: (userId: string) => `rl:prox-pairs:hour:${userId}`,
  pairsPerDay: (userId: string) => `rl:prox-pairs:day:${userId}`,
  /**
   * (A2-3; A2 rev. 1, R1-6) Sinal de abuso: bloqueios feitos (`blocker`) ou recebidos (`blocked`)
   * pela conta até 60 s depois de um casamento, em 7 dias (só o contador).
   */
  blockSignal: (role: BlockSignalRole, userId: string) =>
    `rl:prox-block-after-touch:${role}:${userId}`,
};

/** O papel no sinal de abuso do Conectar (A2-3): quem bloqueou ou quem foi bloqueado. */
export type BlockSignalRole = 'blocker' | 'blocked';

/** (A2 rev. 1, R1-6) Os dois contadores do sinal depois de contar um bloqueio. */
export interface BlockSignalCounts {
  blocker: number;
  blocked: number;
}

/**
 * Porta do estado efêmero da proximidade (tokens, tela aberta, encostos, contadores de abuso e
 * bloqueio). Em produção é o Redis/Valkey; o fake em memória (`MemoryProximityStore`) serve aos
 * testes, com o `Clock` controlando as validades, e ao desenvolvimento sem Docker
 * (`PROXIMITY_STORE=memory`).
 *
 * Quem usa trata qualquer erro como indisponível e fecha a proximidade (fail-closed, R11).
 */
export abstract class ProximityStore {
  /**
   * Grava o token como válido e recente (com o canal no registro), marca a tela aberta e indexa o
   * hash na conta. Cada emissão chama uma vez por canal.
   */
  abstract issue(hash: string, record: ProximityTokenRecord, ttls: ProximityTtls): Promise<void>;
  /** Registro de cada hash ainda **válido**, na ordem pedida (`null` se vencido ou inexistente). */
  abstract findValid(hashes: readonly string[]): Promise<(ProximityTokenRecord | null)[]>;
  /** Registro do hash **válido ou recente** (até 120 s depois da emissão). */
  abstract findRecent(hash: string): Promise<ProximityTokenRecord | null>;
  abstract isScreenOpen(userId: string): Promise<boolean>;
  /** Invalida todos os tokens da conta e a marca de tela aberta (logout e exclusão, PROX-27). */
  abstract revokeUser(userId: string): Promise<void>;
  /** Contador de janela fixa (a mesma semântica do rate limit da API). */
  abstract hit(key: string, windowMs: number): Promise<RateLimitHit>;
  abstract lock(userId: string, ms: number): Promise<void>;
  /** Quanto falta para o bloqueio acabar (0 = sem bloqueio). */
  abstract lockRemainingMs(userId: string): Promise<number>;
  /**
   * (ADR 0012 §3, A2-2) Atômico: grava que `observerId` relatou o encosto com `ownerId` (o token
   * de hash `ownerTokenHash`) e diz se a observação de `ownerId` sobre `observerId` está **dentro
   * da janela** (`atMs − primeiroMs < windowMs`). A própria observação guarda o horário do primeiro
   * relato e o hash do último. (A2 rev. 1, R1-1) Prazo deslizante: todo relato a regrava com
   * `2 × windowMs` desde agora, e o `primeiroMs` não muda; ela só some depois de `2 × windowMs` sem
   * relato. Valor em formato antigo ou ilegível = não existe (abre uma observação nova).
   */
  abstract recordTouch(
    observerId: string,
    ownerId: string,
    ownerTokenHash: string,
    atMs: number,
    windowMs: number,
  ): Promise<boolean>;
  /**
   * (A2-2) O casamento, atômico: confere a janela da observação do outro (`gone`), (ADR 0012, A3-1)
   * se a política recusou (`callerCard` nulo → `refused`, sem ler nem gravar par, contadores, cartão
   * devido ou ocupado), quem está ocupado (`busy`) e o teto de pares novos dos dois (`capped`; a
   * renovação não conta); grava o par, o cartão de quem chama devido ao outro (com o hash da
   * observação do outro) e marca quem chama como ocupado. Em `capped`, `busy`, `gone` e `refused`,
   * nada é gravado.
   */
  abstract claimTouchPair(input: ClaimTouchPairInput): Promise<TouchClaim>;
  /**
   * (A2-2; ADR 0012, A3-2) Retira o cartão devido, atômico. Sem cartão → `null`, sem gravar nada.
   * - **Primeira entrega:** não apaga; marca como entregue (`!`), encurta o prazo para
   *   `min(o que falta, busyMs)` e marca a conta como ocupada por `busyMs`. `redelivered: false`.
   * - **Reentrega** (já marcado): o mesmo cartão, sem mexer em prazo nem em ocupado.
   *   `redelivered: true`.
   * Valor ilegível → `null`, sem apagar (vence em até `busyMs`).
   */
  abstract takeOwedCard(recipientId: string, busyMs: number): Promise<DeliveredOwedCard | null>;
  /**
   * Grava (ou renova) o par encostado, que libera o pedido `ble` entre os dois por `ttlMs`. (A2) Só
   * para o `/dev/simulate-request`: o casamento de verdade é o `claimTouchPair`.
   */
  abstract markTouchPair(first: string, second: string, ttlMs: number, atMs: number): Promise<void>;
  /** O par encostado ainda vale (em qualquer ordem dos dois ids)? */
  abstract hasTouchPair(first: string, second: string): Promise<boolean>;
  /**
   * (A2 rev. 1, R1-6) Sinal de abuso, atômico: se o par de `blockerId` e `blockedId` vive e este
   * sentido (quem bloqueou → quem foi bloqueado) ainda não foi contado neste casamento, marca o
   * sentido no valor do par (sem mudar o prazo, `KEEPTTL`) e soma 1 em
   * `rl:prox-block-after-touch:blocker:{blockerId}` e em `…:blocked:{blockedId}` (janela fixa de
   * `windowMs`, aberta no primeiro). Devolve os dois contadores depois da soma; sem par, com valor
   * ilegível ou com o sentido já contado → `null`, sem gravar nada.
   */
  abstract countBlockSignal(
    blockerId: string,
    blockedId: string,
    windowMs: number,
  ): Promise<BlockSignalCounts | null>;
  /**
   * (A2-2 §7) Só para as rotas de desenvolvimento: apaga o cartão devido e a marca de ocupado da
   * conta (a persona simulada nunca relata, então nunca receberia o cartão).
   */
  abstract forgetTouchState(userId: string): Promise<void>;
}

function isChannel(value: unknown): value is ProximityChannel {
  return value === 'ble' || value === 'qr';
}

function encodeRecord(record: ProximityTokenRecord): string {
  return JSON.stringify({ uid: record.userId, iat: record.issuedAt, ch: record.channel });
}

/**
 * Registro sem canal válido (inclusive os gravados antes da ADR 0012) não vale para nada: é tratado
 * como inexistente, o que fecha a porta para um token sem canal ser usado nos dois caminhos.
 */
function decodeRecord(value: string | null | undefined): ProximityTokenRecord | null {
  if (value === null || value === undefined) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as { uid?: unknown; iat?: unknown; ch?: unknown };
    return typeof parsed.uid === 'string' && typeof parsed.iat === 'number' && isChannel(parsed.ch)
      ? { userId: parsed.uid, issuedAt: parsed.iat, channel: parsed.ch }
      : null;
  } catch {
    return null;
  }
}

/** Observação do encosto (A2-2): o horário do primeiro relato e o hash do token relatado por último. */
interface Observation {
  firstMs: number;
  hash: string;
}

/**
 * `"{primeiroMs}:{hash}"`, como o `string.match(v, '^(%d+):(.+)$')` dos scripts Lua. Formato antigo
 * (só o horário) ou ilegível = não existe (fecha, como o `decodeRecord`).
 */
function decodeObservation(value: string | null): Observation | null {
  const [, first, hash] = (value === null ? null : /^(\d+):([\s\S]+)$/.exec(value)) ?? [];
  return first === undefined || hash === undefined ? null : { firstMs: Number(first), hash };
}

/**
 * (R1-6) O sentido de um bloqueio no valor do par: `a` = o menor id (o primeiro da chave
 * `prox:m`, a mesma comparação do `proximityKeys.pair`) bloqueou o maior; `b` = o contrário.
 */
export function blockSignalDirection(blockerId: string, blockedId: string): 'a' | 'b' {
  return blockerId < blockedId ? 'a' : 'b';
}

/**
 * Valor de `prox:m` (R1-6): `"{horário}"` ou `"{horário}:{sentidos}"`, como o
 * `string.match(v, '^(%d+):?([ab]*)$')` do `BLOCK_SIGNAL_SCRIPT`. Qualquer outra coisa → `null`.
 */
function decodePair(value: string | null): { at: string; marks: string } | null {
  const [, at, marks] = (value === null ? null : /^(\d+):?([ab]*)$/.exec(value)) ?? [];
  return at === undefined || marks === undefined ? null : { at, marks };
}

/** O cartão no valor de `prox:v` (`{s, at, h, n, a, c}`): curto, sem token e sem o id do destinatário. */
function encodeCard(card: TouchCard): string {
  return JSON.stringify({
    s: card.subjectId,
    at: card.atMs,
    h: card.handle,
    n: card.name,
    a: card.avatarKey,
    c: card.connected,
  });
}

/** `"{hash}|{json}"` → o cartão devido. Qualquer outra coisa → `null` (fecha). */
function decodeOwedCard(value: string | null): OwedCard | null {
  const separator = value === null ? -1 : value.indexOf('|');
  if (value === null || separator <= 0) {
    return null;
  }
  try {
    const card = JSON.parse(value.slice(separator + 1)) as Record<string, unknown>;
    const valid =
      typeof card.s === 'string' &&
      typeof card.at === 'number' &&
      typeof card.h === 'string' &&
      typeof card.n === 'string' &&
      (card.a === null || typeof card.a === 'string') &&
      typeof card.c === 'boolean';
    return valid
      ? {
          tokenHash: value.slice(0, separator),
          subjectId: card.s as string,
          atMs: card.at as number,
          handle: card.h as string,
          name: card.n as string,
          avatarKey: card.a as string | null,
          connected: card.c as boolean,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * (A3-2) O valor que o `TAKE_OWED_CARD_SCRIPT` devolve: `"{hash}|{json}"` na primeira entrega,
 * `"!{hash}|{json}"` na reentrega. Tira a marca e diz se era reentrega. Ilegível → `null` (fecha).
 */
function decodeDeliveredOwedCard(value: string | null): DeliveredOwedCard | null {
  if (value === null) {
    return null;
  }
  const redelivered = value.startsWith(REDELIVERY_MARK);
  const card = decodeOwedCard(redelivered ? value.slice(REDELIVERY_MARK.length) : value);
  return card === null ? null : { ...card, redelivered };
}

/**
 * Relato do encosto (ADR 0012 §3, A2-2; A2 rev. 1, R1-1), atômico.
 * KEYS[1] = `prox:o:{observador}:{dono}`, KEYS[2] = `prox:o:{dono}:{observador}`;
 * ARGV[1] = agora (ms), ARGV[2] = janela (ms), ARGV[3] = hash do token relatado.
 * Todo relato regrava a própria observação com `PX 2 × janela` (prazo deslizante, sem `KEEPTTL`):
 * mantém o horário do primeiro relato se ela já existe (e é legível) e troca o hash; senão, abre
 * uma nova com o horário de agora. Devolve 1 se a observação do outro existe e o primeiro relato
 * dela tem menos que a janela.
 */
export const TOUCH_SCRIPT = `
local window = tonumber(ARGV[2])
local own = redis.call('GET', KEYS[1])
local first = own and string.match(own, '^(%d+):.+$')
redis.call('SET', KEYS[1], (first or ARGV[1]) .. ':' .. ARGV[3], 'PX', 2 * window)
local other = redis.call('GET', KEYS[2])
local otherFirst = other and string.match(other, '^(%d+):.+$')
if otherFirst and tonumber(ARGV[1]) - tonumber(otherFirst) < window then
  return 1
end
return 0
`;

/**
 * O casamento (A2-2 §2), atômico.
 * KEYS: 1 `prox:m:{par}`; 2 `prox:o:{outro}:{quemChama}`; 3, 4 `rl:prox-pairs:hour|day:{quemChama}`;
 * 5, 6 `rl:prox-pairs:hour|day:{outro}`; 7, 8 `prox:v:{outro}`, `prox:v:{quemChama}`;
 * 9, 10 `prox:c:{outro}`, `prox:c:{quemChama}`.
 * ARGV: 1 agora (ms), 2 TTL do par, 3 janela, 4 teto por hora, 5 janela da hora, 6 teto por dia,
 * 7 janela do dia, 8 o cartão de quem chama (JSON; `''` quando a política recusou, A3-1),
 * 9 tempo de ocupado.
 * 1. sem a observação do outro, ilegível ou fora da janela → `gone`;
 *    (ADR 0012, A3-1) sem o cartão de quem chama (`ARGV[8] == ''`) → `refused`, sem ler nem gravar
 *    par, contadores, cartão devido ou ocupado;
 * 2. cartão devido (inclusive o já entregue, à espera da reentrega, A3-2) ou marca de ocupado de
 *    qualquer um dos dois → `busy`;
 * 3. par novo com qualquer contador no teto → `capped`; senão, `INCR` dos quatro (com `PEXPIRE` na
 *    primeira vez, como o `RATE_LIMIT_SCRIPT`). Par existente = renovação, não conta;
 * 4 a 6. grava o par, o cartão devido ao outro (`"{hash da observação}|{cartão}"`, com o TTL do
 *    par) e a marca de ocupado de quem chama.
 * O par é regravado só com o horário, inclusive na renovação: um casamento novo limpa os sentidos
 * já contados no sinal de abuso (A2 rev. 1, R1-6). Os passos 2 e 3 só olham se o par existe.
 */
export const CLAIM_TOUCH_SCRIPT = `
local now = tonumber(ARGV[1])
local observed = redis.call('GET', KEYS[2])
local first, hash = false, false
if observed then
  first, hash = string.match(observed, '^(%d+):(.+)$')
end
if not first or now - tonumber(first) >= tonumber(ARGV[3]) then
  return 'gone'
end
if ARGV[8] == '' then return 'refused' end
for index = 7, 10 do
  if redis.call('EXISTS', KEYS[index]) == 1 then
    return 'busy'
  end
end
local outcome = 'renewed'
if redis.call('EXISTS', KEYS[1]) == 0 then
  local limits = {ARGV[4], ARGV[6], ARGV[4], ARGV[6]}
  local windows = {ARGV[5], ARGV[7], ARGV[5], ARGV[7]}
  for index = 1, 4 do
    if tonumber(redis.call('GET', KEYS[index + 2]) or '0') >= tonumber(limits[index]) then
      return 'capped'
    end
  end
  for index = 1, 4 do
    local count = redis.call('INCR', KEYS[index + 2])
    if count == 1 or redis.call('PTTL', KEYS[index + 2]) < 0 then
      redis.call('PEXPIRE', KEYS[index + 2], windows[index])
    end
  end
  outcome = 'created'
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
redis.call('SET', KEYS[7], hash .. '|' .. ARGV[8], 'PX', ARGV[2])
redis.call('SET', KEYS[10], '1', 'PX', ARGV[9])
return outcome
`;

/**
 * Retirada do cartão devido (A2-2 §3, passo 2; ADR 0012, A3-2), atômica.
 * KEYS[1] = `prox:v:{uid}`, KEYS[2] = `prox:c:{uid}`; ARGV[1] = tempo de ocupado (ms), que é também
 * o da reentrega.
 * - sem cartão → nil, sem gravar nada;
 * - já entregue (começa com `!`) → o valor marcado, sem mexer em prazo nem em ocupado (reentrega);
 * - primeira entrega → marca com `!`, encurta o prazo para `min(o que falta, ARGV[1])`, marca a
 *   conta como ocupada por `ARGV[1]` e devolve o valor sem a marca.
 * O script não lê o JSON: um valor ilegível também é marcado e vence em até `ARGV[1]` (o adaptador
 * devolve `null`).
 */
export const TAKE_OWED_CARD_SCRIPT = `
local card = redis.call('GET', KEYS[1])
if not card then return false end
if string.sub(card, 1, 1) == '!' then return card end
local keep = tonumber(ARGV[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl > 0 and ttl < keep then keep = ttl end
redis.call('SET', KEYS[1], '!' .. card, 'PX', keep)
redis.call('SET', KEYS[2], '1', 'PX', ARGV[1])
return card
`;

/**
 * Sinal de abuso (A2 rev. 1, R1-6), atômico: conta um bloqueio no máximo uma vez por casamento e
 * por sentido, com a marca no valor do próprio par.
 * KEYS[1] = `prox:m:{menor}:{maior}`, KEYS[2] = `rl:prox-block-after-touch:blocker:{quemBloqueou}`,
 * KEYS[3] = `rl:prox-block-after-touch:blocked:{quemFoiBloqueado}`;
 * ARGV[1] = sentido (`a` se quem bloqueou é o menor id do par, `b` se é o maior), ARGV[2] = janela
 * dos contadores (ms, 7 dias).
 * Sem par, valor ilegível ou sentido já marcado → nil, sem gravar nada. Senão, acrescenta o sentido
 * ao valor do par sem mudar o prazo (`KEEPTTL`), soma 1 nos dois contadores (com `PEXPIRE` na
 * primeira vez, como o `RATE_LIMIT_SCRIPT`) e devolve `{blocker, blocked}`.
 */
export const BLOCK_SIGNAL_SCRIPT = `
local pair = redis.call('GET', KEYS[1])
if not pair then return false end
local at, marks = string.match(pair, '^(%d+):?([ab]*)$')
if not at or string.find(marks, ARGV[1], 1, true) then return false end
redis.call('SET', KEYS[1], at .. ':' .. marks .. ARGV[1], 'KEEPTTL')
local counts = {}
for index = 2, 3 do
  local count = redis.call('INCR', KEYS[index])
  if count == 1 or redis.call('PTTL', KEYS[index]) < 0 then
    redis.call('PEXPIRE', KEYS[index], ARGV[2])
  end
  counts[index - 1] = count
end
return counts
`;

type ProximityRedis = Pick<
  Redis,
  'multi' | 'mget' | 'get' | 'exists' | 'smembers' | 'del' | 'set' | 'pttl' | 'eval'
>;

export class RedisProximityStore extends ProximityStore {
  constructor(private readonly redis: ProximityRedis) {
    super();
  }

  async issue(hash: string, record: ProximityTokenRecord, ttls: ProximityTtls): Promise<void> {
    const value = encodeRecord(record);
    const results = await this.redis
      .multi()
      .set(proximityKeys.valid(hash), value, 'PX', ttls.validMs)
      .set(proximityKeys.recent(hash), value, 'PX', ttls.recentMs)
      .set(proximityKeys.screen(record.userId), hash, 'PX', ttls.screenMs)
      .sadd(proximityKeys.issued(record.userId), hash)
      .pexpire(proximityKeys.issued(record.userId), ttls.recentMs)
      .exec();
    const failed = results?.find(([error]) => error !== null);
    if (results === null || failed !== undefined) {
      throw failed?.[0] ?? new Error('MULTI do token de proximidade não executou');
    }
  }

  async findValid(hashes: readonly string[]): Promise<(ProximityTokenRecord | null)[]> {
    if (hashes.length === 0) {
      return [];
    }
    const values = await this.redis.mget(...hashes.map(proximityKeys.valid));
    return values.map(decodeRecord);
  }

  async findRecent(hash: string): Promise<ProximityTokenRecord | null> {
    return decodeRecord(await this.redis.get(proximityKeys.recent(hash)));
  }

  async isScreenOpen(userId: string): Promise<boolean> {
    return (await this.redis.exists(proximityKeys.screen(userId))) === 1;
  }

  async revokeUser(userId: string): Promise<void> {
    const hashes = await this.redis.smembers(proximityKeys.issued(userId));
    await this.redis.del(
      ...hashes.flatMap((hash) => [proximityKeys.valid(hash), proximityKeys.recent(hash)]),
      proximityKeys.screen(userId),
      proximityKeys.issued(userId),
    );
  }

  async hit(key: string, windowMs: number): Promise<RateLimitHit> {
    const [count, ttl] = (await this.redis.eval(RATE_LIMIT_SCRIPT, 1, key, String(windowMs))) as [
      number,
      number,
    ];
    return { count, resetInMs: ttl > 0 ? ttl : windowMs };
  }

  async lock(userId: string, ms: number): Promise<void> {
    await this.redis.set(proximityKeys.lock(userId), '1', 'PX', ms);
  }

  async lockRemainingMs(userId: string): Promise<number> {
    const ttl = await this.redis.pttl(proximityKeys.lock(userId));
    return ttl > 0 ? ttl : 0;
  }

  async recordTouch(
    observerId: string,
    ownerId: string,
    ownerTokenHash: string,
    atMs: number,
    windowMs: number,
  ): Promise<boolean> {
    const inWindow = await this.redis.eval(
      TOUCH_SCRIPT,
      2,
      proximityKeys.touch(observerId, ownerId),
      proximityKeys.touch(ownerId, observerId),
      String(atMs),
      String(windowMs),
      ownerTokenHash,
    );
    return inWindow === 1;
  }

  async claimTouchPair(input: ClaimTouchPairInput): Promise<TouchClaim> {
    const { callerId, otherId } = input;
    const outcome = await this.redis.eval(
      CLAIM_TOUCH_SCRIPT,
      10,
      proximityKeys.pair(callerId, otherId),
      proximityKeys.touch(otherId, callerId),
      proximityKeys.pairsPerHour(callerId),
      proximityKeys.pairsPerDay(callerId),
      proximityKeys.pairsPerHour(otherId),
      proximityKeys.pairsPerDay(otherId),
      proximityKeys.owed(otherId),
      proximityKeys.owed(callerId),
      proximityKeys.busy(otherId),
      proximityKeys.busy(callerId),
      String(input.atMs),
      String(input.pairTtlMs),
      String(input.windowMs),
      String(input.perHour),
      String(TOUCH_PAIRS_HOUR_MS),
      String(input.perDay),
      String(TOUCH_PAIRS_DAY_MS),
      // A3-1: `''` = a política recusou (o script volta `refused` depois do passo do `gone`).
      input.callerCard === null ? '' : encodeCard(input.callerCard),
      String(input.busyMs),
    );
    if (!TOUCH_CLAIMS.includes(outcome as TouchClaim)) {
      throw new Error('Resposta inesperada do script do casamento');
    }
    return outcome as TouchClaim;
  }

  async takeOwedCard(recipientId: string, busyMs: number): Promise<DeliveredOwedCard | null> {
    const value = await this.redis.eval(
      TAKE_OWED_CARD_SCRIPT,
      2,
      proximityKeys.owed(recipientId),
      proximityKeys.busy(recipientId),
      String(busyMs),
    );
    return decodeDeliveredOwedCard(typeof value === 'string' ? value : null);
  }

  async markTouchPair(first: string, second: string, ttlMs: number, atMs: number): Promise<void> {
    await this.redis.set(proximityKeys.pair(first, second), String(atMs), 'PX', ttlMs);
  }

  async hasTouchPair(first: string, second: string): Promise<boolean> {
    return (await this.redis.exists(proximityKeys.pair(first, second))) === 1;
  }

  async countBlockSignal(
    blockerId: string,
    blockedId: string,
    windowMs: number,
  ): Promise<BlockSignalCounts | null> {
    const counts = await this.redis.eval(
      BLOCK_SIGNAL_SCRIPT,
      3,
      proximityKeys.pair(blockerId, blockedId),
      proximityKeys.blockSignal('blocker', blockerId),
      proximityKeys.blockSignal('blocked', blockedId),
      blockSignalDirection(blockerId, blockedId),
      String(windowMs),
    );
    if (counts === null) {
      return null;
    }
    if (
      !Array.isArray(counts) ||
      counts.length !== 2 ||
      !counts.every((count) => typeof count === 'number')
    ) {
      throw new Error('Resposta inesperada do script do sinal de bloqueio');
    }
    const [blocker, blocked] = counts as [number, number];
    return { blocker, blocked };
  }

  async forgetTouchState(userId: string): Promise<void> {
    await this.redis.del(proximityKeys.owed(userId), proximityKeys.busy(userId));
  }
}

interface Expiring<T> {
  value: T;
  expiresAt: number;
}

/** Acima deste número de chaves, cada emissão varre as vencidas (processo de dev de longa duração). */
const SWEEP_THRESHOLD = 1_000;

/**
 * Fake em memória da porta, com as mesmas chaves e validades do Redis sobre o `Clock`. Nos testes,
 * o relógio avança em vez de esperar os 30 ou 120 s (sem `sleep`). Em desenvolvimento sem Docker
 * (`PROXIMITY_STORE=memory`), vale para uma instância só da API e some ao reiniciar.
 */
export class MemoryProximityStore extends ProximityStore {
  private readonly values = new Map<string, Expiring<string>>();
  private readonly sets = new Map<string, Expiring<Set<string>>>();
  private readonly counters = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly clock: Clock) {
    super();
  }

  private now(): number {
    return this.clock.now().getTime();
  }

  private read(key: string): string | null {
    const entry = this.values.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.values.delete(key);
      return null;
    }
    return entry.value;
  }

  private write(key: string, value: string, ttlMs: number): void {
    this.values.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  private sweep(): void {
    if (this.values.size < SWEEP_THRESHOLD) {
      return;
    }
    const now = this.now();
    for (const [key, entry] of this.values) {
      if (entry.expiresAt <= now) {
        this.values.delete(key);
      }
    }
    for (const [key, entry] of this.sets) {
      if (entry.expiresAt <= now) {
        this.sets.delete(key);
      }
    }
  }

  issue(hash: string, record: ProximityTokenRecord, ttls: ProximityTtls): Promise<void> {
    this.sweep();
    const value = encodeRecord(record);
    this.write(proximityKeys.valid(hash), value, ttls.validMs);
    this.write(proximityKeys.recent(hash), value, ttls.recentMs);
    this.write(proximityKeys.screen(record.userId), hash, ttls.screenMs);
    const key = proximityKeys.issued(record.userId);
    const current = this.sets.get(key);
    const members =
      current !== undefined && current.expiresAt > this.now() ? current.value : new Set<string>();
    members.add(hash);
    this.sets.set(key, { value: members, expiresAt: this.now() + ttls.recentMs });
    return Promise.resolve();
  }

  findValid(hashes: readonly string[]): Promise<(ProximityTokenRecord | null)[]> {
    return Promise.resolve(
      hashes.map((hash) => decodeRecord(this.read(proximityKeys.valid(hash)))),
    );
  }

  findRecent(hash: string): Promise<ProximityTokenRecord | null> {
    return Promise.resolve(decodeRecord(this.read(proximityKeys.recent(hash))));
  }

  isScreenOpen(userId: string): Promise<boolean> {
    return Promise.resolve(this.read(proximityKeys.screen(userId)) !== null);
  }

  revokeUser(userId: string): Promise<void> {
    const key = proximityKeys.issued(userId);
    for (const hash of this.sets.get(key)?.value ?? []) {
      this.values.delete(proximityKeys.valid(hash));
      this.values.delete(proximityKeys.recent(hash));
    }
    this.values.delete(proximityKeys.screen(userId));
    this.sets.delete(key);
    return Promise.resolve();
  }

  /** Valor do contador na janela atual, sem incrementar (o `GET` do script do casamento). */
  private count(key: string): number {
    const current = this.counters.get(key);
    return current === undefined || current.resetAt <= this.now() ? 0 : current.count;
  }

  /** `INCR` com a janela fixa aberta no primeiro (o `RATE_LIMIT_SCRIPT`). */
  private increment(key: string, windowMs: number): RateLimitHit {
    const now = this.now();
    const current = this.counters.get(key);
    const window =
      current === undefined || current.resetAt <= now
        ? { count: 1, resetAt: now + windowMs }
        : { count: current.count + 1, resetAt: current.resetAt };
    this.counters.set(key, window);
    return { count: window.count, resetInMs: window.resetAt - now };
  }

  hit(key: string, windowMs: number): Promise<RateLimitHit> {
    return Promise.resolve(this.increment(key, windowMs));
  }

  lock(userId: string, ms: number): Promise<void> {
    this.write(proximityKeys.lock(userId), '1', ms);
    return Promise.resolve();
  }

  lockRemainingMs(userId: string): Promise<number> {
    const key = proximityKeys.lock(userId);
    if (this.read(key) === null) {
      return Promise.resolve(0);
    }
    return Promise.resolve((this.values.get(key)?.expiresAt ?? 0) - this.now());
  }

  /**
   * O mesmo do `TOUCH_SCRIPT`: num processo só, cada método roda sem intercalar com os outros.
   * (R1-1) Todo relato regrava a observação com `2 × janela` desde agora, mantendo o `primeiroMs`.
   */
  recordTouch(
    observerId: string,
    ownerId: string,
    ownerTokenHash: string,
    atMs: number,
    windowMs: number,
  ): Promise<boolean> {
    this.sweep();
    const ownKey = proximityKeys.touch(observerId, ownerId);
    const own = decodeObservation(this.read(ownKey));
    this.write(ownKey, `${String(own?.firstMs ?? atMs)}:${ownerTokenHash}`, 2 * windowMs);
    const other = decodeObservation(this.read(proximityKeys.touch(ownerId, observerId)));
    return Promise.resolve(other !== null && atMs - other.firstMs < windowMs);
  }

  /** O mesmo do `CLAIM_TOUCH_SCRIPT`, passo a passo. */
  claimTouchPair(input: ClaimTouchPairInput): Promise<TouchClaim> {
    const { callerId, otherId, atMs, callerCard } = input;
    const observed = decodeObservation(this.read(proximityKeys.touch(otherId, callerId)));
    if (observed === null || atMs - observed.firstMs >= input.windowMs) {
      return Promise.resolve('gone');
    }
    // A3-1: a política recusou. Depois do `gone`, antes de ler par, contadores, devido ou ocupado.
    if (callerCard === null) {
      return Promise.resolve('refused');
    }
    const occupied = [
      proximityKeys.owed(otherId),
      proximityKeys.owed(callerId),
      proximityKeys.busy(otherId),
      proximityKeys.busy(callerId),
    ].some((key) => this.read(key) !== null);
    if (occupied) {
      return Promise.resolve('busy');
    }
    const pairKey = proximityKeys.pair(callerId, otherId);
    let outcome: TouchClaim = 'renewed';
    if (this.read(pairKey) === null) {
      const counters: [string, number, number][] = [
        [proximityKeys.pairsPerHour(callerId), input.perHour, TOUCH_PAIRS_HOUR_MS],
        [proximityKeys.pairsPerDay(callerId), input.perDay, TOUCH_PAIRS_DAY_MS],
        [proximityKeys.pairsPerHour(otherId), input.perHour, TOUCH_PAIRS_HOUR_MS],
        [proximityKeys.pairsPerDay(otherId), input.perDay, TOUCH_PAIRS_DAY_MS],
      ];
      // A leitura sem incremento vem antes: no teto, nenhum contador muda.
      if (counters.some(([key, limit]) => this.count(key) >= limit)) {
        return Promise.resolve('capped');
      }
      for (const [key, , windowMs] of counters) {
        this.increment(key, windowMs);
      }
      outcome = 'created';
    }
    this.write(pairKey, String(atMs), input.pairTtlMs);
    this.write(
      proximityKeys.owed(otherId),
      `${observed.hash}|${encodeCard(callerCard)}`,
      input.pairTtlMs,
    );
    this.write(proximityKeys.busy(callerId), '1', input.busyMs);
    return Promise.resolve(outcome);
  }

  /**
   * O mesmo do `TAKE_OWED_CARD_SCRIPT` (A3-2): a primeira entrega marca com `!`, encurta o prazo
   * para `min(expiresAt, agora + busyMs)` e grava o ocupado; a reentrega só lê. Como o script, não
   * olha o JSON: o valor ilegível também é marcado (e o adaptador devolve `null`).
   */
  takeOwedCard(recipientId: string, busyMs: number): Promise<DeliveredOwedCard | null> {
    const key = proximityKeys.owed(recipientId);
    const value = this.read(key);
    if (value === null) {
      return Promise.resolve(null);
    }
    if (value.startsWith(REDELIVERY_MARK)) {
      return Promise.resolve(decodeDeliveredOwedCard(value));
    }
    const now = this.now();
    const expiresAt = this.values.get(key)?.expiresAt ?? now + busyMs;
    this.values.set(key, {
      value: `${REDELIVERY_MARK}${value}`,
      expiresAt: Math.min(expiresAt, now + busyMs),
    });
    this.write(proximityKeys.busy(recipientId), '1', busyMs);
    return Promise.resolve(decodeDeliveredOwedCard(value));
  }

  markTouchPair(first: string, second: string, ttlMs: number, atMs: number): Promise<void> {
    this.write(proximityKeys.pair(first, second), String(atMs), ttlMs);
    return Promise.resolve();
  }

  hasTouchPair(first: string, second: string): Promise<boolean> {
    return Promise.resolve(this.read(proximityKeys.pair(first, second)) !== null);
  }

  /** O mesmo do `BLOCK_SIGNAL_SCRIPT`: a marca mantém o prazo do par (o `KEEPTTL`). */
  countBlockSignal(
    blockerId: string,
    blockedId: string,
    windowMs: number,
  ): Promise<BlockSignalCounts | null> {
    const pairKey = proximityKeys.pair(blockerId, blockedId);
    const pair = decodePair(this.read(pairKey));
    const entry = this.values.get(pairKey);
    const direction = blockSignalDirection(blockerId, blockedId);
    if (pair === null || entry === undefined || pair.marks.includes(direction)) {
      return Promise.resolve(null);
    }
    this.values.set(pairKey, {
      value: `${pair.at}:${pair.marks}${direction}`,
      expiresAt: entry.expiresAt,
    });
    return Promise.resolve({
      blocker: this.increment(proximityKeys.blockSignal('blocker', blockerId), windowMs).count,
      blocked: this.increment(proximityKeys.blockSignal('blocked', blockedId), windowMs).count,
    });
  }

  forgetTouchState(userId: string): Promise<void> {
    this.values.delete(proximityKeys.owed(userId));
    this.values.delete(proximityKeys.busy(userId));
    return Promise.resolve();
  }

  /** Chaves e valores vivos (PROX-01: o teste confere que o token nunca aparece em claro). */
  entries(): { key: string; value: string }[] {
    const now = this.now();
    const plain = [...this.values]
      .filter(([, entry]) => entry.expiresAt > now)
      .map(([key, entry]) => ({ key, value: entry.value }));
    const sets = [...this.sets]
      .filter(([, entry]) => entry.expiresAt > now)
      .map(([key, entry]) => ({ key, value: [...entry.value].join(',') }));
    return [...plain, ...sets];
  }

  clear(): void {
    this.values.clear();
    this.sets.clear();
    this.counters.clear();
  }
}
