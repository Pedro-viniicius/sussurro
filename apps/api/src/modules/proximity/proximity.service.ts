import { Injectable, Logger } from '@nestjs/common';
import { users } from '@sussurro/db';
import {
  ErrorCode,
  type NearbyPerson,
  type ProximityResolveResult,
  type ProximityToken,
  type ProximityTouchItem,
  type ProximityTouchResult,
} from '@sussurro/shared';

import {
  generateProximityToken,
  hashProximityToken,
  PROXIMITY_LIMITS,
  PROXIMITY_LOCK_MS,
} from './proximity-token.js';
import { type NearbyRow, ProximityRepository } from './proximity.repository.js';
import {
  type BlockSignalRole,
  type OwedCard,
  type ProximityChannel,
  ProximityStore,
  type ProximityTtls,
} from './proximity.store.js';
import { withTimeout } from '../../common/async/with-timeout.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { Clock } from '../../common/clock/clock.js';
import { describeError } from '../../common/errors/describe-error.js';
import { DomainError } from '../../common/errors/domain-error.js';
import type { RateLimitRule } from '../../common/rate-limit/rate-limiter.service.js';
import { AppConfig } from '../../config/config.module.js';
import { MediaService } from '../media/media.service.js';
import { AccessPolicyService } from '../policies/access-policy.service.js';

/** Tempo máximo esperando o Redis antes de responder 503 (fail-closed, R11). */
export const PROXIMITY_STORE_TIMEOUT_MS = 500;

export function proximityUnavailable(): DomainError {
  return new DomainError(
    ErrorCode.PROXIMITY_UNAVAILABLE,
    503,
    'Conectar está indisponível agora. Tente de novo em instantes.',
  );
}

export function screenClosed(): DomainError {
  return new DomainError(
    ErrorCode.PROXIMITY_SCREEN_CLOSED,
    409,
    'Abra a tela Conectar para continuar.',
  );
}

/**
 * Mensagem única para token inexistente, vencido, de outra pessoa, de conta excluída, com bloqueio
 * ou dentro do intervalo depois de uma recusa (PROX-17, X.2 CA2): o corpo é sempre o mesmo.
 */
export function proximityTokenInvalid(): DomainError {
  return new DomainError(
    ErrorCode.PROXIMITY_TOKEN_INVALID,
    400,
    'Não foi possível enviar o pedido agora. Tente mais tarde.',
  );
}

function tooManyAttempts(retryAfterMs: number): DomainError {
  return new DomainError(ErrorCode.RATE_LIMITED, 429, 'Muitas tentativas', {
    retryAfterS: Math.max(1, Math.ceil(retryAfterMs / 1000)),
  });
}

/** Os dois tokens de uma emissão (ADR 0012 §1): um para o anúncio, outro para o QR. */
export interface IssuedTokens {
  bleToken: string;
  qrToken: string;
  issuedAt: Date;
}

/** O token mais recente de cada dono entre os enviados, com a ordem do primeiro token dele. */
type NewestByOwner = Map<string, { token: string; issuedAt: number; order: number }>;

/** O papel de uma conta no sinal de abuso do encostar (ADR 0012, A2-3). */
export type ProximityAbuseRole = BlockSignalRole;

/**
 * Uma conta que chegou a exatamente 3 bloqueios (como quem bloqueou ou como quem foi bloqueada)
 * até 60 s depois de um encosto, em 7 dias: vira um e-mail para a moderação (A2-3).
 */
export interface ProximityAbuseFlag {
  userId: string;
  role: ProximityAbuseRole;
}

/** A resposta de `touches` sem cartão: a mesma para não mútuo, teto, ocupado e janela vencida. */
const NO_CARD: ProximityTouchResult = { items: [] };

/**
 * Degrau do `pairExpiresInS` (PROX-64): o prazo do par sai arredondado para baixo em múltiplos de
 * 5 s, para o casamento na hora e o cartão devido darem o mesmo valor (PROX-37).
 */
export const PAIR_EXPIRES_STEP_S = 5;

/** Código da linha de log quando o teto barra um par novo (A2-1): sem ids e sem tokens. */
export const PROXIMITY_TOUCH_CAPPED = 'PROXIMITY_TOUCH_CAPPED';

/**
 * Tokens de proximidade (ADR 0003, história 4.2; ADR 0012), o relato do encosto (`touches`) e o
 * `resolve` do QR. Também valida, para o módulo `connections`, os tokens de quem pede e de quem
 * aceita (com o canal), o par encostado, a tela aberta e os limites de abuso. Tudo que toca o Redis
 * falha **fechado**: sem Redis, 503 `PROXIMITY_UNAVAILABLE`, e login, feed e perfil seguem normais
 * (PROX-21).
 *
 * Privacidade (ADR 0012): nenhuma rota recebe dado de sinal (RSSI, potência, modelo); um token BLE
 * só vira pessoa no encosto mútuo, e o encosto vive só no Redis, por até 60 s, sem ir para o
 * Postgres nem para o log. (A2) O cartão devido (@, nome, chave da foto, `alreadyConnected`) também
 * vive só no Redis, até 60 s e com entrega única; os contadores do teto e do sinal de abuso guardam
 * só números, sem a outra parte.
 */
@Injectable()
export class ProximityService {
  private readonly logger = new Logger(ProximityService.name);
  private readonly ttls: ProximityTtls;
  /** O app renova a cada 20 s com o TTL padrão de 30 s (2/3 da validade). */
  private readonly renewInS: number;
  /** Janela do casamento, contada do primeiro relato do outro (`prox:o`, 5 s; A2-2). */
  private readonly touchWindowMs: number;
  /** Validade do par encostado (`prox:m`) e do cartão devido (`prox:v`), 60 s. */
  private readonly touchPairTtlMs: number;
  private readonly touchPairTtlS: number;
  /** Quanto tempo quem recebe um cartão fica ocupado (`prox:c`, `2 × janela` = 10 s; A2-2). */
  private readonly touchBusyMs: number;
  /** Teto de pessoas novas por conta (A2-1): 10 por hora e 30 por dia. */
  private readonly touchPairsPerHour: number;
  private readonly touchPairsPerDay: number;

  constructor(
    private readonly store: ProximityStore,
    private readonly repository: ProximityRepository,
    private readonly policy: AccessPolicyService,
    private readonly media: MediaService,
    private readonly clock: Clock,
    config: AppConfig,
  ) {
    this.ttls = {
      validMs: config.env.PROX_TOKEN_TTL_S * 1000,
      recentMs: config.env.PROX_RECENT_TTL_S * 1000,
      screenMs: config.env.PROX_SCREEN_TTL_S * 1000,
    };
    this.renewInS = Math.max(1, Math.round((config.env.PROX_TOKEN_TTL_S * 2) / 3));
    this.touchWindowMs = config.env.PROX_TOUCH_WINDOW_S * 1000;
    this.touchPairTtlS = config.env.PROX_TOUCH_PAIR_TTL_S;
    this.touchPairTtlMs = this.touchPairTtlS * 1000;
    this.touchBusyMs = 2 * this.touchWindowMs;
    this.touchPairsPerHour = config.env.PROX_TOUCH_PAIRS_PER_HOUR;
    this.touchPairsPerDay = config.env.PROX_TOUCH_PAIRS_PER_DAY;
  }

  /** Uma operação no store com prazo: erro ou demora viram 503 (fail-closed). */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await withTimeout(operation(), PROXIMITY_STORE_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn(`Proximidade indisponível (fechada): ${describeError(error)}`);
      throw proximityUnavailable();
    }
  }

  /** Bloqueio de 15 min depois de 20 falhas de token (PROX-20): 429 com `Retry-After`. */
  async assertNotLocked(viewer: AuthContext): Promise<void> {
    const remaining = await this.guarded(() => this.store.lockRemainingMs(viewer.userId));
    if (remaining > 0) {
      throw tooManyAttempts(remaining);
    }
  }

  /** Conta uma tentativa no limite (por conta) e lança 429 acima dele. */
  async consume(rule: RateLimitRule, viewer: AuthContext): Promise<void> {
    const hit = await this.guarded(() =>
      this.store.hit(`rl:${rule.name}:${viewer.userId}`, rule.windowMs),
    );
    if (hit.count > rule.limit) {
      throw tooManyAttempts(hit.resetInMs);
    }
  }

  /** `prox:u` de quem chama: a tela Conectar está aberta (PROX-04, PROX-10). */
  async assertScreenOpen(viewer: AuthContext): Promise<void> {
    if (!(await this.guarded(() => this.store.isScreenOpen(viewer.userId)))) {
      throw screenClosed();
    }
  }

  /**
   * Dono do token se ele ainda é **válido** (até 30 s) **e** do canal pedido: o que o pedido `qr`
   * exige. Token do outro canal = inexistente (ADR 0012).
   */
  async ownerOfValidToken(token: string, channel: ProximityChannel): Promise<string | null> {
    const [record] = await this.guarded(() => this.store.findValid([hashProximityToken(token)]));
    return record?.channel === channel ? record.userId : null;
  }

  /**
   * Dono do token se ele é válido **ou recente** (até 120 s) **e** do canal pedido: o que o aceite
   * `qr` (PROX-03) e o pedido `ble` com o par exigem. Token do outro canal = inexistente.
   */
  async ownerOfRecentToken(token: string, channel: ProximityChannel): Promise<string | null> {
    const record = await this.guarded(() => this.store.findRecent(hashProximityToken(token)));
    return record?.channel === channel ? record.userId : null;
  }

  /**
   * O par encostado das duas contas ainda vale (ADR 0012 §4: o pedido `ble` só nasce com ele). Os
   * 60 s contam do último casamento no servidor.
   */
  hasTouchPair(first: string, second: string): Promise<boolean> {
    return this.guarded(() => this.store.hasTouchPair(first, second));
  }

  /**
   * (ADR 0012, A2 rev. 1, R1-5) O fato que a política usa para bloquear e denunciar pelo cartão: o
   * leitor e `otherId` têm par encostado vivo (até 60 s depois do último casamento). Só lê o par
   * (`EXISTS`), nunca o consome. Sem conta (`otherId` ausente: @ inexistente, excluído ou
   * inválido), consulta uma chave que nunca existe (o próprio id nos dois lados), para o tempo e a
   * falha não revelarem se a conta existe. Fail-closed: Valkey fora ou lento → 503
   * `PROXIMITY_UNAVAILABLE`, igual para qualquer @.
   */
  hasLiveTouchPair(viewerId: string, otherId: string | undefined): Promise<boolean> {
    return this.guarded(() => this.store.hasTouchPair(viewerId, otherId ?? viewerId));
  }

  /**
   * Conta uma falha de token (pedido ou aceite recusado). Na 20ª em 10 min, a proximidade da conta
   * fica bloqueada por 15 min, também no QR (PROX-20, 4.7 CA7).
   */
  async recordFailure(viewer: AuthContext): Promise<void> {
    const rule = PROXIMITY_LIMITS.failures;
    const hit = await this.guarded(() =>
      this.store.hit(`rl:${rule.name}:${viewer.userId}`, rule.windowMs),
    );
    if (hit.count >= rule.limit) {
      await this.guarded(() => this.store.lock(viewer.userId, PROXIMITY_LOCK_MS));
    }
  }

  /**
   * Emite e grava os dois tokens da conta, um por canal, com a mesma emissão e a mesma validade
   * (ADR 0012 §1). O servidor guarda só os hashes, com o canal no registro.
   */
  private async issueFor(userId: string): Promise<IssuedTokens> {
    const issuedAt = this.clock.now();
    const bleToken = generateProximityToken();
    const qrToken = generateProximityToken();
    for (const [token, channel] of [
      [bleToken, 'ble'],
      [qrToken, 'qr'],
    ] as const) {
      await this.guarded(() =>
        this.store.issue(
          hashProximityToken(token),
          { userId, issuedAt: issuedAt.getTime(), channel },
          this.ttls,
        ),
      );
    }
    return { bleToken, qrToken, issuedAt };
  }

  /**
   * `POST /proximity/tokens` (4.2): os dois tokens novos (`bleToken` para o anúncio, `qrToken` para
   * o QR), válidos por 30 s, e a tela marcada como aberta. O app pede outros a cada `renewInS`
   * (20 s) enquanto a tela está em primeiro plano. O limite de 6 por minuto conta a emissão.
   */
  async issueToken(viewer: AuthContext): Promise<ProximityToken> {
    await this.assertNotLocked(viewer);
    await this.consume(PROXIMITY_LIMITS.tokens, viewer);
    const { bleToken, qrToken, issuedAt } = await this.issueFor(viewer.userId);
    return {
      bleToken,
      qrToken,
      expiresAt: new Date(issuedAt.getTime() + this.ttls.validMs).toISOString(),
      renewInS: this.renewInS,
    };
  }

  /**
   * Tokens para uma persona do seed (só as rotas de simulação em desenvolvimento, 4.11): sem
   * limite, mas com a mesma gravação e a mesma validade.
   */
  issueForSimulation(personaId: string): Promise<IssuedTokens> {
    return this.issueFor(personaId);
  }

  /**
   * Simulação em desenvolvimento (ADR 0012 §7, A2-2 §7): a persona relata o encosto com a conta,
   * como se o celular dela tivesse visto o da conta encostado (um hash aleatório no lugar do token
   * que ela "viu"). A conta completa o casamento relatando o `bleToken` da persona em `touches`
   * dentro da janela (5 s). A persona nunca relata, então o cartão devido a ela nunca sairia e a
   * deixaria ocupada por 60 s: antes, a simulação apaga o cartão devido e a marca de ocupado dela.
   */
  async simulateTouchFrom(personaId: string, viewerId: string): Promise<void> {
    await this.guarded(() => this.store.forgetTouchState(personaId));
    const seen = hashProximityToken(generateProximityToken());
    const at = this.clock.now().getTime();
    await this.guarded(() =>
      this.store.recordTouch(personaId, viewerId, seen, at, this.touchWindowMs),
    );
  }

  /** Simulação em desenvolvimento: grava o par encostado da persona com a conta (pedido `ble`). */
  async simulateTouchPair(personaId: string, viewerId: string): Promise<void> {
    const at = this.clock.now().getTime();
    await this.guarded(() =>
      this.store.markTouchPair(personaId, viewerId, this.touchPairTtlMs, at),
    );
  }

  /**
   * Os tokens **válidos** (até 30 s) do canal pedido, agrupados por dono: fica o mais recente de
   * cada pessoa, na ordem do primeiro token dela no pedido (PROX-25). Ficam de fora, sem aviso, os
   * repetidos, os inexistentes ou vencidos, os do outro canal e os do próprio chamador.
   */
  private async newestByOwner(
    viewer: AuthContext,
    tokens: readonly string[],
    channel: ProximityChannel,
  ): Promise<NewestByOwner> {
    const unique = [...new Set(tokens)];
    const records = await this.guarded(() =>
      this.store.findValid(unique.map((token) => hashProximityToken(token))),
    );
    const newest: NewestByOwner = new Map();
    unique.forEach((token, order) => {
      const record = records[order];
      // Sem registro (inexistente ou vencido), do outro canal ou do próprio chamador: ignorado.
      if (record?.channel !== channel || record.userId === viewer.userId) {
        return;
      }
      const current = newest.get(record.userId);
      if (current === undefined) {
        newest.set(record.userId, { token, issuedAt: record.issuedAt, order });
      } else if (record.issuedAt > current.issuedAt) {
        newest.set(record.userId, { token, issuedAt: record.issuedAt, order: current.order });
      }
    });
    return newest;
  }

  /** O cartão (@, nome, foto, `alreadyConnected` e o token enviado) de cada conta, na ordem. */
  private async cards(rows: readonly NearbyRow[], newest: NewestByOwner): Promise<NearbyPerson[]> {
    const people = await Promise.all(
      rows.map(async (row): Promise<NearbyPerson & { order: number }> => {
        const seen = newest.get(row.id);
        return {
          token: seen?.token ?? '',
          handle: row.handle,
          name: row.name,
          avatarUrl: await this.media.signUrl(row.avatarKey),
          alreadyConnected: row.connected,
          order: seen?.order ?? 0,
        };
      }),
    );
    return people
      .sort((first, second) => first.order - second.order)
      .map(({ order: _order, ...person }) => person);
  }

  /**
   * `POST /proximity/resolve` (4.4; ADR 0012: **só o QR**): cada `qrToken` **válido** vira o cartão
   * da pessoa que mostrou o QR. Ficam de fora, sem aviso e com a mesma resposta de token
   * inexistente, os tokens inválidos ou vencidos, os do Bluetooth (`bleToken`, PROX-05), os do
   * próprio chamador, os de conta excluída ou de criador e os de quem tem bloqueio com ele em
   * qualquer sentido. Exige a tela aberta de quem chama (PROX-04).
   *
   * Tokens que não resolvem **não** contam como falha. O limite de 30 chamadas por minuto, com até
   * 20 tokens cada, segura a força bruta.
   */
  async resolve(viewer: AuthContext, tokens: readonly string[]): Promise<ProximityResolveResult> {
    await this.assertNotLocked(viewer);
    await this.consume(PROXIMITY_LIMITS.resolve, viewer);
    await this.assertScreenOpen(viewer);

    const newest = await this.newestByOwner(viewer, tokens, 'qr');
    const rows = await this.repository.findNearby(
      viewer.userId,
      [...newest.keys()],
      this.policy.hideBlockedFor(viewer, users.id),
    );
    return { items: await this.cards(rows, newest) };
  }

  /**
   * `POST /proximity/touches` (ADR 0012 §3 e Adendo A2): quem chama afirma que o celular encostou no
   * do dono do `bleToken` `t` (exatamente 1 por chamada; o schema garante, e só o primeiro conta).
   * Os guards e o schema vêm antes (conta pessoal, e-mail confirmado, 1 token). Depois:
   * 1. **o cartão devido** (A2-2): se alguém casou com quem chama e deixou o próprio cartão, ele é
   *    entregue agora, uma vez, sem passar de novo pela política (a decisão foi no casamento), e o
   *    relato para aqui. É o que garante a revelação simétrica mesmo que o outro bloqueie, exclua a
   *    conta ou saia logo depois. (A2 rev. 1, R1-4) Sai **antes de qualquer recusa**: não consome o
   *    limite, não exige a tela aberta e sai mesmo com a proximidade bloqueada. Fail-closed: sem o
   *    Redis, 503, e o cartão continua guardado;
   * 2. sem cartão devido: sem bloqueio de proximidade (429), 60 por minuto (429) e a tela aberta
   *    (409, PROX-04);
   * 3. `t` precisa ser **válido** (até 30 s), do canal `ble` e de outra conta, O; senão, ignorado em
   *    silêncio, sem contar como falha;
   * 4. atômico: grava a observação de quem chama sobre O (o horário do primeiro relato não muda; o
   *    prazo desliza a cada relato, R1-1) e confere se a de O sobre quem chama está na janela (5 s
   *    desde o primeiro relato de O);
   * 5. a política, numa consulta só: O e quem chama, pessoais, ativos e sem bloqueio em nenhum
   *    sentido (o mesmo `findNearby` do `resolve`; a linha de quem chama vira o cartão dele);
   * 6. o casamento (`claimTouchPair`): janela, ocupado, teto de pessoas novas, par, cartão devido a
   *    O e quem chama ocupado, num script só;
   * 7. responde sempre 200 `{items}`, com no máximo um cartão. Não mútuo, vencido, inexistente, do
   *    QR, próprio, de criador, de conta excluída, com bloqueio, no teto, ocupado ou com a janela
   *    vencida são indistinguíveis (PROX-32, PROX-36, PROX-46).
   *
   * Nenhum dado de sinal chega aqui (PROX-43).
   */
  async touches(viewer: AuthContext, tokens: readonly string[]): Promise<ProximityTouchResult> {
    const token = tokens[0];
    // R1-4: com um cartão esperando, qualquer recusa entre quem chama e o cartão (429, 409, bloqueio
    // da proximidade) quebraria o invariante da revelação simétrica. Cada conta só retira o cartão
    // devido a ela mesma, então isto não abre força bruta.
    const owed = await this.guarded(() => this.store.takeOwedCard(viewer.userId, this.touchBusyMs));
    if (owed !== null) {
      return { items: [await this.owedCard(owed, token)] };
    }

    await this.assertNotLocked(viewer);
    await this.consume(PROXIMITY_LIMITS.touches, viewer);
    await this.assertScreenOpen(viewer);
    if (token === undefined) {
      return NO_CARD;
    }

    const newest = await this.newestByOwner(viewer, [token], 'ble');
    const [ownerId] = newest.keys();
    if (ownerId === undefined) {
      return NO_CARD;
    }
    const at = this.clock.now().getTime();
    const inWindow = await this.guarded(() =>
      this.store.recordTouch(
        viewer.userId,
        ownerId,
        hashProximityToken(token),
        at,
        this.touchWindowMs,
      ),
    );
    if (!inWindow) {
      return NO_CARD;
    }

    const rows = await this.repository.findNearby(
      viewer.userId,
      [ownerId, viewer.userId],
      this.policy.hideBlockedFor(viewer, users.id),
    );
    const owner = rows.find((row) => row.id === ownerId);
    const caller = rows.find((row) => row.id === viewer.userId);
    if (owner === undefined || caller === undefined) {
      return NO_CARD;
    }
    const outcome = await this.guarded(() =>
      this.store.claimTouchPair({
        callerId: viewer.userId,
        otherId: ownerId,
        atMs: at,
        pairTtlMs: this.touchPairTtlMs,
        windowMs: this.touchWindowMs,
        busyMs: this.touchBusyMs,
        perHour: this.touchPairsPerHour,
        perDay: this.touchPairsPerDay,
        callerCard: {
          subjectId: caller.id,
          atMs: at,
          handle: caller.handle,
          name: caller.name,
          avatarKey: caller.avatarKey,
          // A conexão é do par: o `connected` da linha de O (vista por quem chama) vale para O.
          connected: owner.connected,
        },
      }),
    );
    if (outcome === 'capped') {
      // Para calibrar o teto: sem ids e sem tokens (A2-1).
      this.logger.warn(`${PROXIMITY_TOUCH_CAPPED}: teto de pessoas novas, encosto não confirmado`);
    }
    if (outcome !== 'created' && outcome !== 'renewed') {
      return NO_CARD;
    }
    // A mesma conta do cartão devido, a partir do horário deste casamento (PROX-37, PROX-64).
    const people = await this.cards([owner], newest);
    return {
      items: people.map((person) => ({ ...person, pairExpiresInS: this.pairExpiresInS(at) })),
    };
  }

  /**
   * Quanto falta para o par do casamento feito em `marriedAtMs` vencer (PROX-64), arredondado para
   * baixo num múltiplo de 5 s e limitado a [0, validade do par]: `5 × floor(max(0, restante − 1) /
   * 5000)`. A mesma conta vale para o casamento na hora e para o cartão devido: sem o degrau de
   * 5 s, 60 contra 59 diria a quem recebe quem casou primeiro (PROX-37). O cartão pode vencer até
   * 5 s antes no app, que já desconta essa margem. O par e o cartão devido foram gravados no mesmo
   * script, com a mesma validade, a partir desse horário.
   */
  private pairExpiresInS(marriedAtMs: number): number {
    const remainingMs = marriedAtMs + this.touchPairTtlMs - this.clock.now().getTime();
    const stepped =
      PAIR_EXPIRES_STEP_S * Math.floor(Math.max(0, remainingMs - 1) / (PAIR_EXPIRES_STEP_S * 1000));
    return Math.min(this.touchPairTtlS, Math.max(0, stepped));
  }

  /**
   * O cartão devido como `ProximityTouchItem` (A2-2 passo 2), indistinguível do cartão do
   * casamento. A foto é assinada agora (se o objeto já foi apagado, a imagem só não carrega). O
   * `token` segue a regra do rótulo: é o `t` relatado só quando se sabe que ele é do dono do cartão
   * (o hash é o guardado no casamento, ou o `findRecent` diz que `t` é dele); em qualquer outro caso
   * (`t` revogado, vencido, inexistente, de **outra** pessoa ou sem resposta do Redis), um token
   * novo que nunca foi emitido nem gravado. Assim o "Conectar" desse cartão dá o 400 genérico e nunca
   * pede conexão a outra pessoa com quem a conta tenha par. (A2 rev. 1) `pairExpiresInS` conta do
   * horário do casamento guardado no cartão: o cartão que chega tarde mostra o prazo que sobra.
   */
  private async owedCard(owed: OwedCard, token: string | undefined): Promise<ProximityTouchItem> {
    return {
      token: await this.owedCardLabel(owed, token),
      handle: owed.handle,
      name: owed.name,
      avatarUrl: await this.media.signUrl(owed.avatarKey),
      alreadyConnected: owed.connected,
      pairExpiresInS: this.pairExpiresInS(owed.atMs),
    };
  }

  private async owedCardLabel(owed: OwedCard, token: string | undefined): Promise<string> {
    if (token === undefined) {
      return generateProximityToken();
    }
    const hash = hashProximityToken(token);
    if (hash === owed.tokenHash) {
      return token;
    }
    try {
      // O cartão já foi retirado: sem o Redis aqui, ele sai com o token que nunca existiu, em vez
      // de se perder num 503.
      const record = await withTimeout(this.store.findRecent(hash), PROXIMITY_STORE_TIMEOUT_MS);
      if (record?.userId === owed.subjectId) {
        return token;
      }
    } catch (error) {
      this.logger.warn(`Rótulo do cartão devido sem o Redis: ${describeError(error)}`);
    }
    return generateProximityToken();
  }

  /**
   * Sinal de abuso (ADR 0012, A2-3): depois de um bloqueio gravado, se as duas contas têm par
   * encostado vivo (até 60 s depois do último casamento), soma 1 para quem bloqueou e 1 para quem
   * foi bloqueado (`rl:prox-block-after-touch:{blocker|blocked}:{uid}`, 7 dias). (A2 rev. 1, R1-6)
   * Um script só (`countBlockSignal`) conta **no máximo uma vez por casamento e por sentido**, com a
   * marca no valor do par: N bloqueios simultâneos, ou bloquear, desbloquear e bloquear de novo,
   * somam 1. Devolve os papéis que chegaram a **exatamente** 3 (o e-mail não se repete na janela).
   * **Falha aberta e nunca lança:** o bloqueio não pode depender do Redis; erro ou demora acima de
   * 500 ms → nenhum sinal, só o log (sem ids).
   */
  async noteBlockAfterTouch(blockerId: string, blockedId: string): Promise<ProximityAbuseFlag[]> {
    const rule = PROXIMITY_LIMITS.blockAfterTouch;
    try {
      const counts = await withTimeout(
        this.store.countBlockSignal(blockerId, blockedId, rule.windowMs),
        PROXIMITY_STORE_TIMEOUT_MS,
      );
      if (counts === null) {
        return [];
      }
      const flags: ProximityAbuseFlag[] = [];
      if (counts.blocker === rule.limit) {
        flags.push({ userId: blockerId, role: 'blocker' });
      }
      if (counts.blocked === rule.limit) {
        flags.push({ userId: blockedId, role: 'blocked' });
      }
      return flags;
    } catch (error) {
      this.logger.warn(`Sinal de bloqueio depois do encosto não contado: ${describeError(error)}`);
      return [];
    }
  }

  /**
   * Logout e exclusão de conta (PROX-27): os tokens da conta deixam de resolver e de valer em
   * pedidos e aceites. Sem Redis, não impede o logout (a autenticação não depende dele, R11): os
   * tokens vencem sozinhos em até 120 s, e a exclusão já some do banco na hora.
   */
  async revokeQuietly(userId: string): Promise<void> {
    try {
      await withTimeout(this.store.revokeUser(userId), PROXIMITY_STORE_TIMEOUT_MS);
    } catch (error) {
      this.logger.warn(`Tokens de proximidade não revogados agora: ${describeError(error)}`);
    }
  }
}
