import {
  type NearbyPerson,
  PROXIMITY_TOUCH_WINDOW_S,
  type ProximityTouchItem,
} from '@sussurro/shared';
import { useCallback, useEffect, useState } from 'react';

import { reportTouch } from './api';
import { connectClock, connectTiming } from './timing';
import { cardExpiresAt, TOUCH_CALIBRATION, type TouchCalibration } from './touch-calibration';
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

/** O cartão de quem encostou: o servidor confirmou os dois lados (P1). */
export interface TouchCard {
  /** `person.token` é o `bleToken` da pessoa: o `targetToken` do pedido. */
  person: NearbyPerson;
  matchedAt: number;
  /** O cartão vence aos 55 s no app (o par vale 60 s no servidor, P4). */
  expiresAt: number;
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
  receiver: TouchReceiver;
  calibration: TouchCalibration;
  onCard: (card: TouchCard) => void;
  /** Erro do relato que não é o 409 de tela fechada (a tela decide se para). */
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
}

const touchReportGate: TouchReportGate = { inFlight: null, lastStartAt: -Infinity, starts: [] };

/** Só para os testes: zera o ritmo e o orçamento entre um teste e outro. */
export function resetTouchReportGate(): void {
  touchReportGate.inFlight = null;
  touchReportGate.lastStartAt = -Infinity;
  touchReportGate.starts = [];
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
 * de cada admissão, o prazo leva a no máximo 8 relatos, então nunca há mais de 39 inícios em
 * qualquer janela de 60 s (o servidor recusa o 61º).
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
   * o prazo para sempre. Admitido, abre a sessão da tela ("Encostou!" e o aviso dos 4 s), troca o
   * token do próximo relato e leva o prazo a pelo menos `agora + reportForMs`; **não** inicia outro
   * laço. Recusado, nada muda: nem a fase, nem a atividade (o QR em destaque aparece aos 20 s sem
   * encosto admitido, P9).
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
    return (
      this.listening &&
      !this.disposed &&
      !this.stopped &&
      this.deps !== null &&
      connectClock.now() < this.reportUntil
    );
  }

  /**
   * O relator, **um só por motor** (R1-3 itens 1 e 2): `POST /proximity/touches` com **um** token,
   * um relato por vez no processo inteiro (espera o relato em voo de qualquer motor) e com pelo menos
   * `reportEveryMs` entre os inícios, mesmo afastados (a revelação é simétrica). Segue enquanto
   * `agora < reportUntil`, até o cartão. Assim, toda janela que o servidor abre sobre este aparelho é
   * seguida de relatos por pelo menos 8 s, contados da resposta do relato que a abriu (R1-2).
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
        const wait = touchReportGate.lastStartAt + calibration.reportEveryMs - connectClock.now();
        if (wait > 0) {
          await sleep(wait);
          continue;
        }
        const token = this.pickToken(connectClock.now(), calibration);
        if (token === null) {
          await sleep(calibration.reportEveryMs);
          continue;
        }
        await this.reportOnce(token, deps);
      }
    } finally {
      this.looping = false;
    }
    if (!this.disposed) this.step();
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
      person = (await reportTouch(deps.api, token)).items[0];
    } catch (error) {
      failure = { error };
    } finally {
      // A resposta libera o próximo relato mesmo fora do Pronto ou com a tela desmontada.
      if (touchReportGate.inFlight === inFlight) touchReportGate.inFlight = null;
      release();
    }
    // Saiu do Pronto (ou desmontou) com o relato em voo: a resposta é descartada (R1-7).
    if (!this.isPeriod(period)) return;
    if (failure !== null) {
      const closed = isApiError(failure.error, 'PROXIMITY_SCREEN_CLOSED');
      // 409 "tela fechada": renova os tokens e segue (não conta como aceito).
      if (closed && (await this.reopenScreen())) return;
      if (!this.isPeriod(period)) return;
      this.stopped = true;
      if (!closed) deps.onReportError(failure.error);
      return;
    }
    if (person !== undefined) {
      // O servidor confirmou os dois lados: para de relatar e abre o cartão (P1, P3). O prazo do
      // cartão vem do par no servidor (`pairExpiresInS`), não só da chegada (PROX-64).
      const matchedAt = connectClock.now();
      const { pairExpiresInS, ...shown } = person;
      this.stopped = true;
      this.session = null;
      this.noticeUntil = null;
      this.failures = 0;
      this.hintLatched = false;
      deps.onCard({
        person: shown,
        matchedAt,
        expiresAt: cardExpiresAt(matchedAt, pairExpiresInS, calibration),
      });
      return;
    }
    // 200 sem cartão: aceito. Token novo leva o prazo a pelo menos `resposta + reportForMs` (R1-2).
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

  /** Ainda no mesmo período do Pronto e montado (a resposta de outro período é descartada). */
  private isPeriod(period: number): boolean {
    return period === this.period && !this.disposed;
  }

  /** 409 "tela fechada": renova os tokens; se não der, o erro vai para a tela. */
  private async reopenScreen(): Promise<boolean> {
    try {
      await this.deps?.refreshScreen();
      return true;
    } catch (error) {
      this.deps?.onReportError(error);
      return false;
    }
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
 * - para quando o cartão chega (`items[0]`), inclusive depois do aviso dos 4 s (9 → 11, P3);
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
  const { api, receiver, onCard, onReportError, onScanError, refreshScreen } = deps;

  useEffect(() => {
    engine.activate();
    return () => {
      engine.dispose();
    };
  }, [engine]);

  useEffect(() => {
    engine.setDeps({
      api,
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
