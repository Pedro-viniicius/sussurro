import {
  type NearbyPerson,
  PROXIMITY_TOUCH_WINDOW_S,
  type ProximityTouchItem,
} from '@sussurro/shared';
import { useCallback, useEffect, useState } from 'react';

import { reportTouch } from './api';
import { isRepeatableFailure } from './errors';
import { connectClock, connectTiming } from './timing';
import { cardActionsUntil, TOUCH_CALIBRATION, type TouchCalibration } from './touch-calibration';
import { TouchDetector, type TouchReceiver } from './touch-detector';
import type { ProximityRadio } from '../../../modules/sussurro-proximity';
import type { ApiClient } from '../../lib/api/client';
import { isApiError } from '../../lib/api/errors';

/**
 * O que a tela mostra no Pronto (ux.md §11.4): `idle` (6), `approaching` (7, "Quase lá"),
 * `confirming` (8, "Encostou!"), `notConfirmed` (9, "Não deu para confirmar") e `noTouch` (10, o
 * QR em destaque). Nenhuma fase diz quem nem quantos estão por perto.
 */
export type TouchPhase = 'idle' | 'approaching' | 'confirming' | 'notConfirmed' | 'noTouch';

/**
 * O cartão de quem encostou: o servidor confirmou os dois lados (P1). Os três últimos dados saem do
 * motor na chegada (ADR 0012, A3-4).
 */
export interface TouchCard {
  /** `person.token` é o rótulo do cartão: o `targetToken` do pedido (só se `canConnect`). */
  person: NearbyPerson;
  /** A chegada do cartão ao app. */
  matchedAt: number;
  /**
   * Até quando o cartão tem ações (Conectar, Bloquear, Denunciar): `chegada + min(55 s,
   * pairExpiresInS × 1000)`, o par no servidor (P4, PROX-64). O cartão comum vence aqui.
   */
  actionsUntil: number;
  /**
   * Cartão atrasado (`pairExpiresInS × 1000 < lateCardBelowMs`; na prática, 0 ou 5): o par está
   * acabando ou acabou no servidor. A tela o mostra sem ações e sem prazo, até a pessoa fechar.
   */
  late: boolean;
  /**
   * O rótulo é o token do relato que trouxe o cartão. Falso só no cartão devido com o token nunca
   * emitido (regra do rótulo, A2-2): o pedido com ele daria o 400 genérico e contaria como falha de
   * token, então a tela tira o Conectar.
   */
  canConnect: boolean;
}

export interface TouchState {
  phase: TouchPhase;
  /** Muda a cada volta ao Pronto e a cada "não deu": a ilustração roda a demonstração de novo. */
  demoRun: number;
  /** Tela acesa no Pronto: sempre no Confirmando; sem encostar, só nos primeiros 2 min. */
  keepAwake: boolean;
}

/** O que o motor precisa de fora (atualizado a cada render). */
export interface TouchDeps {
  api: ApiClient;
  /**
   * O `id` da conta da sessão. O último cartão mostrado é dela (A3-3 item 5): o mesmo @ só é
   * ignorado como reentrega para a mesma conta.
   */
  ownerId: string;
  receiver: TouchReceiver;
  calibration: TouchCalibration;
  /**
   * O cartão que chegou, também de um relato em voo depois de sair do Pronto, enquanto o motor está
   * montado (A3-3 item 6). `true`: a tela mostrou (o mesmo @ passa a ser ignorado por
   * `cardRedeliveryMs`, item 5); `false`: a tela descartou (parada, por exemplo), e ele não conta.
   */
  onCard: (card: TouchCard) => boolean;
  /**
   * Erro do relato que para a tela: o que não é repetível (429, 403, 400…) na hora, ou o último da
   * sequência de falhas quando o relator para com ela aberta (A3-3 item 3). Nunca o 409 de tela
   * fechada que a renovação resolveu.
   */
  onReportError: (error: unknown) => void;
  /** Erro ao ligar a varredura (vem do rádio). */
  onScanError: (error: unknown) => void;
  /** 409 "tela fechada": renova os tokens (marca a tela como aberta) e o relato continua. */
  refreshScreen: () => Promise<void>;
}

/**
 * A sessão da tela: do encosto admitido ao cartão ou ao aviso "Não deu para confirmar" (estado 8 e
 * o 9). Não é um laço de relato: o relator é um só por motor (ADR 0012, A2 rev. 1, R1-3 item 1).
 */
interface TouchSession {
  firstTouchedAt: number;
  /** O aviso "Não deu para confirmar" já saiu. */
  warned: boolean;
}

/**
 * A sequência de falhas (ADR 0012, A3-3 item 3), aberta pela 1ª falha repetível e fechada por
 * qualquer 200: o relator repete o mesmo token até `since + cardRedeliveryMs` (ou o prazo, se for
 * depois). Se ele parar com ela aberta, a tela para com o último erro.
 */
interface FailingRun {
  /** O início do 1º relato que falhou. */
  since: number;
  /** O token repetido: o do relato que falhou. */
  token: string;
  /** O último erro (a tela para com ele). */
  error: unknown;
}

export const INITIAL_TOUCH_STATE: TouchState = {
  phase: 'idle',
  demoRun: 0,
  keepAwake: true,
};

/** A janela do orçamento de relatos: a mesma do limite do servidor (por minuto). */
const BUDGET_WINDOW_MS = 60_000;

/**
 * O ritmo dos relatos, **do processo inteiro** (ADR 0012, A2 rev. 1, R1-3 item 2): fica no módulo,
 * fora do componente, e vale para todas as instâncias do motor. Assim, a troca de sessão, sair e
 * voltar ao Pronto e desmontar e montar a tela não furam o "um relato por vez, com pelo menos 1 s
 * entre os inícios", nem o orçamento.
 */
interface TouchReportGate {
  /** O relato em voo (de qualquer motor); resolve quando a resposta chega, mesmo fora do Pronto. */
  inFlight: Promise<void> | null;
  /** Início do último relato. */
  lastStartAt: number;
  /** Inícios dos últimos 60 s, do mais antigo ao mais novo. */
  starts: number[];
  /**
   * O último cartão mostrado, por qualquer motor (A3-3 item 5): o servidor reentrega o mesmo cartão
   * por até 10 s (A3-2), e o mesmo @ chegando nesse tempo é ignorado. Fica no módulo porque outra
   * instância do motor pode ter mostrado o cartão. É **da conta** (`ownerId`): sai da memória
   * quando a sessão termina ou troca (`useTouchSessionScope`), e o de outra conta nunca vale.
   */
  lastCard: { ownerId: string; handle: string; shownAt: number } | null;
}

const touchReportGate: TouchReportGate = {
  inFlight: null,
  lastStartAt: -Infinity,
  starts: [],
  lastCard: null,
};

/** Só para os testes: zera o ritmo, o orçamento e o último cartão entre um teste e outro. */
export function resetTouchReportGate(): void {
  touchReportGate.inFlight = null;
  touchReportGate.lastStartAt = -Infinity;
  touchReportGate.starts = [];
  touchReportGate.lastCard = null;
}

/**
 * Esquece o último cartão mostrado: o @ de quem encostou não fica na memória do processo depois
 * que a sessão termina.
 *
 * Só ele: o ritmo e o orçamento (`inFlight`, `lastStartAt` e `starts`) continuam. São do processo
 * inteiro de propósito (R1-3 item 2: valem também na troca de sessão) e não guardam dado da pessoa,
 * só instantes. Zerados, deixariam um relato da conta anterior ainda em voo (até 4 s) sobrepor o
 * primeiro da conta nova. Manter custa pouco: na pior hipótese, a conta nova espera os inícios do
 * último minuto saírem da janela, e o limite do servidor é por conta.
 */
function forgetShownTouchCard(): void {
  touchReportGate.lastCard = null;
}

/**
 * O estado do encostar que é da conta, no módulo, acompanha a sessão. A pilha raiz chama com o
 * `id` da conta logada (ou `null`), como faz com os stores por conta. Quando ele muda, o último
 * cartão mostrado é esquecido: ao sair, ao sair de todos, ao excluir a conta, ao redefinir a senha,
 * com a sessão expirada ou revogada e na troca de conta. Todos esses caminhos levam o usuário do
 * `AuthProvider` a `null`.
 *
 * A limpeza roda no fim do efeito da conta anterior. Isso acontece no mesmo commit em que a tela
 * Conectar desmonta, depois do `dispose` do motor: um relato em voo que chega depois não grava mais
 * nada. Sem isso, o @ ficaria na memória depois de sair. E, se outra conta entrasse em até 10 s e
 * recebesse o cartão do mesmo @, ele seria descartado, embora o servidor já o tenha marcado como
 * entregue (revelação assimétrica).
 */
export function useTouchSessionScope(ownerId: string | null): void {
  useEffect(
    () => () => {
      forgetShownTouchCard();
    },
    [ownerId],
  );
}

/** Quantos relatos começaram nos últimos 60 s (e esquece os mais antigos). */
function recentStarts(now: number): number {
  const { starts } = touchReportGate;
  while (starts.length > 0 && (starts[0] ?? now) <= now - BUDGET_WINDOW_MS) starts.shift();
  return starts.length;
}

/**
 * O portão do orçamento (R1-3 item 5): um encosto novo, ou um token que pode contar como novo, só
 * entra com no máximo `reportBudgetPerMinute − reportReserve` (30) inícios nos últimos 60 s. Depois
 * de cada admissão, o prazo leva a no máximo 8 relatos (39 inícios em 60 s). Com a sequência de
 * falhas e o 200 que a encerra estendendo o prazo uma vez, o pior caso medido é 51 por admissão,
 * sem alternância (a sequência acrescenta no máximo 4 inícios: o dos 10 s já não sai). Com uma rede
 * que alterna, cada 200 que encerra uma sequência de falhas depois de ≥ 5 s sem aceite estende o
 * prazo de novo, e a conta chega a 56 em 60 s, sempre abaixo dos 60 do servidor, que recusa o 61º
 * (ADR 0012, A3-3 item 7 e A3-8 item 1; aceito pelo Tech Lead em 2026-10-31).
 */
function budgetOpen(now: number, calibration: TouchCalibration): boolean {
  return recentStarts(now) <= calibration.reportBudgetPerMinute - calibration.reportReserve;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * O motor do "encostar" (ADR 0012 §2; ux.md §11.4), sem React: o detector, o relato ao servidor e
 * as fases da tela. O hook `useTouch` só liga e desliga.
 */
export class TouchEngine {
  private deps: TouchDeps | null = null;
  private listening = false;
  private disposed = false;
  private detector: TouchDetector | null = null;
  private previousTouched: ReadonlySet<string> = new Set();
  private session: TouchSession | null = null;
  /** Período do Pronto: muda a cada entrada e saída (a resposta de outro período é descartada). */
  private period = 0;
  /** Fim do relato (R1-3 item 3): um prazo só, que nunca desce dentro do período do Pronto. */
  private reportUntil = -Infinity;
  /** Início do último relato aceito (200 sem cartão) de cada token, no período (R1-3 item 4). */
  private accepted = new Map<string, number>();
  private lastAccepted: string | null = null;
  /** O token do próximo relato sem ninguém encostado: o do encosto admitido, depois o último relatado. */
  private token: string | null = null;
  /** O relato parou no período (o cartão chegou ou deu erro); um encosto admitido recomeça. */
  private stopped = false;
  /** O relator (um só por motor) está rodando. */
  private looping = false;
  /** A sequência de falhas aberta no período (A3-3 item 3), ou `null`. */
  private failing: FailingRun | null = null;
  /** Fim do aviso "Não deu para confirmar" (estado 9). */
  private noticeUntil: number | null = null;
  /** "Não deu" seguidos, sem cartão no meio (P9). */
  private failures = 0;
  /** O QR em destaque já apareceu nesta volta ao Pronto (fica até sair do Pronto). */
  private hintLatched = false;
  /** Começo do Pronto ou o último encosto admitido (para os 20 s sem encostar). */
  private lastActivityAt = 0;
  private lastNearAt: number | null = null;
  /** Começo do "quase" contínuo (para os 10 s em "quase"). */
  private nearSince: number | null = null;
  private demoRun = 0;
  private published: TouchState = INITIAL_TOUCH_STATE;

  constructor(private readonly publish: (state: TouchState) => void) {}

  setDeps(deps: TouchDeps): void {
    this.deps = deps;
  }

  /** Liga a varredura (uma sessão contínua, P7). Devolve a função que desliga. */
  startScanning(radio: ProximityRadio): () => void {
    const deps = this.deps;
    if (deps === null) return () => undefined;
    const { calibration, receiver } = deps;
    const detector = new TouchDetector(calibration, receiver);
    this.detector = detector;
    this.previousTouched = new Set();
    let cancelled = false;
    const subscription = radio.onSighting((sighting) => {
      if (detector.record(sighting, connectClock.now())) this.step();
    });
    // No Android, a varredura começa ~500 ms depois de abrir a aba (limite de ~5 inícios em 30 s).
    const timer = setTimeout(() => {
      radio
        .startScan({ minIntervalMs: calibration.sightingMinIntervalMs })
        .catch((error: unknown) => {
          if (!cancelled) this.deps?.onScanError(error);
        });
    }, calibration.scanStartDelayMs[receiver.platform]);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      subscription.remove();
      radio.stopScan().catch(() => undefined);
      if (this.detector === detector) this.detector = null;
    };
  }

  /**
   * Entrar (ou voltar) no Pronto recomeça os relógios, o prazo e o mapa de tokens aceitos (zerar só
   * torna tudo novo, o que só estende o relato, R1-3 item 4); fora do Pronto, nada é relatado.
   */
  setListening(listening: boolean): void {
    if (this.listening === listening) return;
    this.listening = listening;
    this.period += 1;
    this.session = null;
    this.noticeUntil = null;
    this.reportUntil = -Infinity;
    this.accepted = new Map();
    this.lastAccepted = null;
    this.token = null;
    this.stopped = false;
    // A sequência de falhas é do período: fora do Pronto, nada é relatado, e a tela não para.
    this.failing = null;
    if (!listening) return;
    this.lastActivityAt = connectClock.now();
    this.lastNearAt = null;
    this.nearSince = null;
    this.hintLatched = false;
    // Quem já estava encostado (ex.: cancelou o cartão sem afastar) precisa encostar de novo.
    this.previousTouched = this.detector?.touchedTokens() ?? new Set();
    this.demoRun += 1;
    this.step();
  }

  /** Montado (de novo, no modo estrito do React em dev). */
  activate(): void {
    this.disposed = false;
  }

  dispose(): void {
    this.disposed = true;
    this.session = null;
  }

  /**
   * Só em dev: relata o `bleToken` de uma persona como se tivesse encostado (`simulate-touch`).
   * Passa pelo mesmo portão e pelo mesmo ritmo do encosto de verdade (R1-3 item 8).
   */
  simulate(bleToken: string): void {
    if (!this.listening || this.disposed) return;
    this.admit(bleToken, connectClock.now());
    this.step();
  }

  /** Recalcula o detector, o aviso, o QR em destaque e a fase no instante atual. */
  step(): void {
    const deps = this.deps;
    if (this.disposed || deps === null) return;
    const now = connectClock.now();
    this.detector?.evaluate(now);
    const touched = this.detector?.touchedTokens() ?? new Set<string>();
    const freshTouch = [...touched].some((token) => !this.previousTouched.has(token));
    this.previousTouched = touched;
    if (!this.listening) return;
    const { calibration } = deps;

    if (freshTouch) {
      const token = this.detector?.strongestTouched() ?? null;
      if (token !== null) this.admit(token, now);
    }

    const contact = this.detector?.contact() ?? 'far';
    if (contact === 'near' || contact === 'touching') {
      this.lastNearAt = now;
      this.nearSince ??= now;
    }
    const approaching =
      this.lastNearAt !== null && now - this.lastNearAt < connectTiming.approachingLeaveMs;
    if (!approaching) this.nearSince = null;

    const session = this.session;
    if (
      session !== null &&
      !session.warned &&
      (now - session.firstTouchedAt >= calibration.confirmWarnAfterMs || !this.looping)
    ) {
      session.warned = true;
      this.failures += 1;
      this.noticeUntil = now + connectTiming.notConfirmedNoticeMs;
      this.demoRun += 1;
    }
    if (this.noticeUntil !== null && now >= this.noticeUntil) {
      this.noticeUntil = null;
      if (this.session !== null && !this.looping) this.session = null;
    }

    const confirming = this.session !== null && !this.session.warned;
    if (!confirming) {
      if (now - this.lastActivityAt >= calibration.noTouchFallbackMs) this.hintLatched = true;
      if (this.nearSince !== null && now - this.nearSince >= calibration.nearFallbackMs) {
        this.hintLatched = true;
      }
      if (this.failures >= calibration.failuresBeforeQr) this.hintLatched = true;
    }

    let phase: TouchPhase;
    if (confirming) phase = 'confirming';
    else if (this.noticeUntil !== null) phase = 'notConfirmed';
    else if (this.hintLatched) phase = 'noTouch';
    else if (approaching) phase = 'approaching';
    else phase = 'idle';
    const keepAwake =
      confirming ||
      this.noticeUntil !== null ||
      now - this.lastActivityAt < connectTiming.keepAwakeIdleMs;
    const previous = this.published;
    if (
      previous.phase !== phase ||
      previous.demoRun !== this.demoRun ||
      previous.keepAwake !== keepAwake
    ) {
      this.published = { phase, demoRun: this.demoRun, keepAwake };
      this.publish(this.published);
    }
  }

  /**
   * Um encosto novo (ADR 0012, A2 rev. 1, R1-3 itens 1, 3 e 5). Só entra se o orçamento deixar,
   * seja o token novo ou não: sem isso, um transmissor que some e volta com o mesmo token estenderia
   * o prazo para sempre. Admitido, abre a sessão da tela ("Encostou!" e o aviso dos 7 s), troca o
   * token do próximo relato e leva o prazo a pelo menos `agora + reportForMs`; **não** inicia outro
   * laço. Com a sequência de falhas aberta, o token novo só vai depois de ela acabar (A3-3 item 3).
   * Recusado, nada muda: nem a fase, nem a atividade (o QR em destaque aparece aos 20 s sem encosto
   * admitido, P9).
   */
  private admit(token: string, now: number): void {
    const deps = this.deps;
    if (deps === null || !budgetOpen(now, deps.calibration)) return;
    this.session = { firstTouchedAt: now, warned: false };
    this.noticeUntil = null;
    this.nearSince = null;
    this.lastActivityAt = now;
    this.token = token;
    this.stopped = false;
    this.reportUntil = Math.max(this.reportUntil, now + deps.calibration.reportForMs);
    void this.runReports();
  }

  /** O token pode contar como novo: nunca aceito no período, ou o último relato aceito dele começou há 5 s ou mais. */
  private mayBeNew(token: string, now: number): boolean {
    const startedAt = this.accepted.get(token);
    return startedAt === undefined || now - startedAt >= PROXIMITY_TOUCH_WINDOW_S * 1000;
  }

  /**
   * O token do relato (P8; R1-3 item 6): sem cartão, o encostado de menor perda; afastados, o último
   * relatado. Se ele pode contar como novo e o orçamento não deixa, o token novo é ignorado e o
   * relato segue com o último token aceito. O relato de cobertura (o último aceito, ou um token
   * aceito há menos de 5 s) nunca é recusado: cortar o prazo de um token já relatado reabriria o
   * MÉDIO 1. `null`: nenhum token pode ser relatado agora.
   */
  private pickToken(now: number, calibration: TouchCalibration): string | null {
    const candidate = this.detector?.strongestTouched() ?? this.token;
    if (candidate === null) return this.lastAccepted;
    if (
      candidate === this.lastAccepted ||
      !this.mayBeNew(candidate, now) ||
      budgetOpen(now, calibration)
    ) {
      return candidate;
    }
    return this.lastAccepted;
  }

  /** O relator pode seguir: no Pronto, montado, sem cartão nem erro, e antes do fim do prazo. */
  private canReport(): boolean {
    const deps = this.deps;
    return (
      this.listening &&
      !this.disposed &&
      !this.stopped &&
      deps !== null &&
      connectClock.now() < this.reportDeadline(deps.calibration)
    );
  }

  /**
   * Até quando o relator segue: o prazo (`reportUntil`) ou, com a sequência de falhas aberta,
   * `cardRedeliveryMs` depois do início do 1º relato que falhou, o que vier depois (A3-3 item 3). Se
   * esse relato retirou o cartão, foi na chegada, depois do início, e a reentrega dura 10 s desde a
   * retirada: qualquer repetição que chegue antes recebe o cartão.
   */
  private reportDeadline(calibration: TouchCalibration): number {
    const failing = this.failing;
    if (failing === null) return this.reportUntil;
    return Math.max(this.reportUntil, failing.since + calibration.cardRedeliveryMs);
  }

  /**
   * O relator, **um só por motor** (R1-3 itens 1 e 2): `POST /proximity/touches` com **um** token,
   * um relato por vez no processo inteiro (espera o relato em voo de qualquer motor) e com pelo menos
   * `reportEveryMs` entre os inícios, mesmo afastados (a revelação é simétrica). Segue até o prazo
   * (`reportDeadline`), até o cartão. Assim, toda janela que o servidor abre sobre este aparelho é
   * seguida de relatos por pelo menos 8 s, contados da resposta do relato que a abriu (R1-2).
   *
   * Com a sequência de falhas aberta (A3-3 item 3), repete o token do relato que falhou, sem a
   * escolha do P8 e sem o portão do orçamento (é cobertura), com `reportRetryEveryMs` entre os
   * inícios. Se parar com ela aberta, a tela para com o último erro (estados 18 e 19).
   */
  private async runReports(): Promise<void> {
    if (this.looping) return;
    this.looping = true;
    try {
      while (this.canReport()) {
        const busy = touchReportGate.inFlight;
        if (busy !== null) {
          await busy;
          continue;
        }
        const deps = this.deps;
        if (deps === null) break;
        const { calibration } = deps;
        const failing = this.failing;
        const every = failing === null ? calibration.reportEveryMs : calibration.reportRetryEveryMs;
        const now = connectClock.now();
        const wait = touchReportGate.lastStartAt + every - now;
        if (wait > 0) {
          // Acorda no prazo, se ele vier antes: a sequência de falhas acaba (e a tela para) na hora.
          await sleep(Math.min(wait, this.reportDeadline(calibration) - now));
          continue;
        }
        const token =
          failing === null ? this.pickToken(connectClock.now(), calibration) : failing.token;
        if (token === null) {
          await sleep(calibration.reportEveryMs);
          continue;
        }
        await this.reportOnce(token, deps);
      }
    } finally {
      this.looping = false;
    }
    this.endFailingRun();
    if (!this.disposed) this.step();
  }

  /**
   * O relator parou com a sequência de falhas aberta: pelo prazo, a tela para com o último erro,
   * como antes (A3-3 item 3). Fora do Pronto ou desmontado, a sequência só é esquecida.
   */
  private endFailingRun(): void {
    const failing = this.failing;
    if (failing === null) return;
    this.failing = null;
    const deps = this.deps;
    if (!this.listening || this.disposed || this.stopped || deps === null) return;
    this.stopped = true;
    deps.onReportError(failing.error);
  }

  /** Um relato: marca o ritmo e o orçamento no módulo e trata a resposta (R1-3 itens 3, 4 e 7). */
  private async reportOnce(token: string, deps: TouchDeps): Promise<void> {
    const { calibration } = deps;
    const period = this.period;
    const startedAt = connectClock.now();
    this.token = token;
    touchReportGate.lastStartAt = startedAt;
    touchReportGate.starts.push(startedAt);
    let release: () => void = () => undefined;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    touchReportGate.inFlight = inFlight;
    let person: ProximityTouchItem | undefined;
    let failure: { error: unknown } | null = null;
    try {
      // O prazo (4 s) aborta a conexão e vira `NetworkError`: o relato em voo nunca prende o portão
      // do processo até o sistema desistir (A3-3 item 1).
      person = (await reportTouch(deps.api, token, calibration.reportTimeoutMs)).items[0];
    } catch (error) {
      failure = { error };
    } finally {
      // A resposta libera o próximo relato mesmo fora do Pronto ou com a tela desmontada.
      if (touchReportGate.inFlight === inFlight) touchReportGate.inFlight = null;
      release();
    }
    if (this.disposed) return;
    const current = this.deps ?? deps;
    if (person !== undefined) {
      // O cartão vai para a tela mesmo depois de sair do Pronto (A3-3 item 6).
      this.receiveCard(person, token, period, current);
      return;
    }
    // Saiu do Pronto com o relato em voo: o erro e o 200 sem cartão são descartados (R1-7).
    if (!this.isPeriod(period)) return;
    if (failure !== null) {
      await this.reportFailed(failure.error, token, startedAt, period, current);
      return;
    }
    // 200 sem cartão: aceito, e a sequência de falhas acaba (A3-3 item 3). Token novo leva o prazo
    // a pelo menos `resposta + reportForMs` (R1-2).
    this.failing = null;
    const respondedAt = connectClock.now();
    const previous = this.accepted.get(token);
    const fresh =
      previous === undefined || respondedAt - previous >= PROXIMITY_TOUCH_WINDOW_S * 1000;
    this.accepted.set(token, startedAt);
    this.lastAccepted = token;
    if (fresh) {
      this.reportUntil = Math.max(this.reportUntil, respondedAt + calibration.reportForMs);
    }
  }

  /**
   * O cartão que chegou (P1, P3; ADR 0012, A3-3 itens 5 e 6, e A3-4).
   *
   * - O mesmo @ do último cartão mostrado à mesma conta há menos de `cardRedeliveryMs` (por
   *   qualquer motor) é a reentrega do servidor: a resposta é **neutra**. Não abre cartão, não conta como aceita, não
   *   estende o prazo e não para o relator; só encerra a sequência de falhas, como todo 200.
   * - O resto vai para a tela, também de um relato em voo depois de sair do Pronto (a tela decide
   *   como mostrar). Mostrado, o relator para (P8: com o cartão na tela, nada é relatado).
   * - Os dados do A3-4 saem aqui, na chegada: `actionsUntil` pelo `pairExpiresInS` (PROX-64),
   *   `late` abaixo de `lateCardBelowMs` e `canConnect` se o rótulo é o token relatado.
   */
  private receiveCard(
    item: ProximityTouchItem,
    reportedToken: string,
    period: number,
    deps: TouchDeps,
  ): void {
    const { calibration } = deps;
    const arrivedAt = connectClock.now();
    if (this.isPeriod(period)) this.failing = null;
    const { pairExpiresInS, ...person } = item;
    const last = touchReportGate.lastCard;
    if (
      last !== null &&
      last.ownerId === deps.ownerId &&
      last.handle === person.handle &&
      arrivedAt - last.shownAt < calibration.cardRedeliveryMs
    ) {
      return;
    }
    const shown = deps.onCard({
      person,
      matchedAt: arrivedAt,
      actionsUntil: cardActionsUntil(arrivedAt, pairExpiresInS, calibration),
      late: pairExpiresInS * 1000 < calibration.lateCardBelowMs,
      canConnect: person.token === reportedToken,
    });
    if (!shown) return;
    touchReportGate.lastCard = { ownerId: deps.ownerId, handle: person.handle, shownAt: arrivedAt };
    this.stopped = true;
    this.failing = null;
    this.session = null;
    this.noticeUntil = null;
    this.failures = 0;
    this.hintLatched = false;
  }

  /**
   * O relato falhou (A3-3 item 2). O 409 "tela fechada" renova os tokens e segue, sem contar como
   * aceito; se a renovação falhar, vale o erro dela. Falha repetível (`NetworkError`, inclusive o
   * prazo, e 5xx) abre a sequência de falhas, ou a continua, com o token do relato; a tela não para.
   * O resto (429, 403, 400…) para a tela na hora, como antes.
   */
  private async reportFailed(
    error: unknown,
    token: string,
    startedAt: number,
    period: number,
    deps: TouchDeps,
  ): Promise<void> {
    let cause = error;
    if (isApiError(error, 'PROXIMITY_SCREEN_CLOSED')) {
      const renewal = await reopenScreen(deps);
      if (!this.isPeriod(period) || renewal === null) return;
      cause = renewal.error;
    }
    if (isRepeatableFailure(cause)) {
      this.failing = { since: this.failing?.since ?? startedAt, token, error: cause };
      return;
    }
    this.stopped = true;
    this.failing = null;
    (this.deps ?? deps).onReportError(cause);
  }

  /** Ainda no mesmo período do Pronto e montado (a resposta de outro período é descartada). */
  private isPeriod(period: number): boolean {
    return period === this.period && !this.disposed;
  }
}

/** 409 "tela fechada": renova os tokens. `null` se deu certo; senão, o erro da renovação. */
async function reopenScreen(deps: TouchDeps): Promise<{ error: unknown } | null> {
  try {
    await deps.refreshScreen();
    return null;
  } catch (error) {
    return { error };
  }
}

export interface UseTouchOptions extends Omit<TouchDeps, 'calibration'> {
  radio: ProximityRadio;
  /**
   * Varredura ligada: a visita à aba no modo Encostar com o Bluetooth pronto. É **uma sessão
   * contínua** (P7): mudar de fase, abrir o cartão ou o pedido não para nem reinicia a varredura.
   */
  scanning: boolean;
  /** O Pronto está na tela (sem cartão, pedido, QR nem erro): só aqui o app relata o encosto. */
  listening: boolean;
  calibration?: TouchCalibration;
}

/**
 * O "encostar" na tela Conectar (ADR 0012 §2; ux.md §11.4): varre enquanto `scanning`, passa cada
 * anúncio pelo detector e, no Pronto (`listening`), cuida do relato ao servidor e das fases:
 *
 * - quando um token vira "encostado" e o orçamento deixa, relata `POST /proximity/touches` com
 *   **um** token (o de menor perda), um relato por vez no processo e com 1 s entre os inícios, até
 *   um prazo único que só cresce: 8 s depois de cada encosto admitido e da resposta de cada relato
 *   aceito de token novo (A2 rev. 1, R1-3), **mesmo depois de afastar**;
 * - para quando o cartão chega (`items[0]`), inclusive depois do aviso dos 7 s (9 → 11, P3); o
 *   cartão de um relato em voo vai para a tela mesmo depois de sair do Pronto, e o mesmo @ do último
 *   cartão mostrado é ignorado por 10 s (a reentrega do servidor; A3-3 itens 5 e 6);
 * - cada relato tem prazo de 4 s; sem rede, com o prazo esgotado ou com 5xx, repete o mesmo token a
 *   cada 2 s por até 10 s antes de parar a tela (A3-3 itens 1 a 3);
 * - com o cartão (ou qualquer coisa fora do Pronto) na tela, não relata nada (P8);
 * - QR em destaque aos 20 s sem encosto admitido, aos 10 s em "quase" ou depois de 2 "não deu" (P9).
 *
 * O RSSI, a potência e o modelo nunca saem do aparelho: o corpo do relato é só `{tokens: [token]}`
 * (PROX-43).
 */
export function useTouch({
  radio,
  scanning,
  listening,
  calibration = TOUCH_CALIBRATION,
  ...deps
}: UseTouchOptions): TouchState & { simulate: (bleToken: string) => void } {
  const [state, setState] = useState<TouchState>(INITIAL_TOUCH_STATE);
  const [engine] = useState(() => new TouchEngine(setState));
  const { api, ownerId, receiver, onCard, onReportError, onScanError, refreshScreen } = deps;

  useEffect(() => {
    engine.activate();
    return () => {
      engine.dispose();
    };
  }, [engine]);

  useEffect(() => {
    engine.setDeps({
      api,
      ownerId,
      receiver,
      calibration,
      onCard,
      onReportError,
      onScanError,
      refreshScreen,
    });
  });

  useEffect(() => {
    if (!scanning) return undefined;
    return engine.startScanning(radio);
  }, [engine, radio, scanning]);

  useEffect(() => {
    engine.setListening(listening);
  }, [engine, listening]);

  useEffect(() => {
    if (!scanning && !listening) return undefined;
    const ticker = setInterval(() => {
      engine.step();
    }, connectTiming.touchTickMs);
    return () => {
      clearInterval(ticker);
    };
  }, [engine, listening, scanning]);

  const simulate = useCallback(
    (bleToken: string) => {
      engine.simulate(bleToken);
    },
    [engine],
  );

  return { ...state, simulate };
}
