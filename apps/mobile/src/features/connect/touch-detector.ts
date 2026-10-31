import type { TouchCalibration } from './touch-calibration';

/**
 * Detecção do encosto no aparelho (ADR 0012 §2 e adendo A1; arquitetura.md §11.2), em TypeScript
 * puro e com o relógio passado de fora. Por token visto na varredura:
 *
 * - **métrica:** perda estimada em dB, `perda = advertiserTxDbm − rssi − correçãoRx` (quanto menor,
 *   mais perto). `advertiserTxDbm` é a referência única de todo emissor, da calibração: **nada que
 *   o emissor declare entra na conta** (A1). Só o token, o RSSI medido aqui e a correção daqui;
 * - **suavização:** mediana das amostras dos últimos `windowMs`, com pelo menos `minSamples`;
 * - **estados:** `far` (longe), `near` (quase), `touching` (encostando) e `touched` (encostado,
 *   depois de `holdMs` em "encostando"); sai de "encostando/encostado" só com a mediana acima de
 *   `exitMinLossDb` (histerese);
 * - RSSI 127 (sem medida), positivo ou abaixo de -127 é descartado; token novo começa do zero.
 *
 * Os limiares vêm do `touch-calibration.ts`. O RSSI e o modelo **nunca saem do aparelho**:
 * o que vai para a API é só o token encostado (PROX-43).
 */

export type TouchContact = 'far' | 'near' | 'touching' | 'touched';

/** Quem recebe o anúncio (este aparelho): a correção por plataforma e por modelo. */
export interface TouchReceiver {
  platform: 'ios' | 'android';
  /** O modelo informado pelo nativo (vazio = sem correção por modelo). */
  model: string;
}

/** Um anúncio visto: só o token e o RSSI medido por este aparelho (ADR 0012, adendo A1). */
export interface TouchSighting {
  token: string;
  rssi: number;
}

/** O que a tela de calibração (dev) mostra por token. */
export interface TouchReading {
  token: string;
  state: TouchContact;
  rssi: number;
  loss: number;
  /** Mediana da janela (`null` com menos de `minSamples` amostras). */
  median: number | null;
  samples: number;
}

const RANK: Record<TouchContact, number> = { far: 0, near: 1, touching: 2, touched: 3 };

/** Token sem anúncio há mais que isto é esquecido (a rotação troca o token a cada 20 s). */
const FORGET_AFTER_MS = 10_000;

/** RSSI de um anúncio real: negativo e não abaixo de -127 (o iOS manda 127 quando não mediu). */
export function isUsableRssi(rssi: number): boolean {
  return Number.isFinite(rssi) && rssi < 0 && rssi >= -127;
}

/**
 * Perda estimada em dB (ADR 0012 §2 e adendo A1). Lê só o `rssi` do avistamento: a referência é a
 * mesma para todo emissor e vem da calibração, nunca do anúncio.
 */
export function estimateLoss(
  { rssi }: Pick<TouchSighting, 'rssi'>,
  receiver: TouchReceiver,
  calibration: TouchCalibration,
): number {
  const correction =
    calibration.rxCorrectionDb[receiver.platform] +
    (calibration.modelCorrectionDb[receiver.model] ?? 0);
  return calibration.advertiserTxDbm - rssi - correction;
}

/** Mediana (ignora os vales de desvanecimento por multipercurso, que a média puxaria). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return ((sorted[middle - 1] ?? upper) + upper) / 2;
}

interface Sample {
  loss: number;
  at: number;
}

interface Track {
  token: string;
  samples: Sample[];
  state: TouchContact;
  /** Quando entrou em "encostando" (para o `holdMs`). */
  touchingSince: number | null;
  lastSeenAt: number;
  last: { rssi: number; loss: number };
  median: number | null;
}

export class TouchDetector {
  private readonly tracks = new Map<string, Track>();

  constructor(
    private readonly calibration: TouchCalibration,
    private readonly receiver: TouchReceiver,
  ) {}

  /** Um anúncio visto. `false` quando a leitura é descartada (RSSI sem medida ou fora da faixa). */
  record(sighting: TouchSighting, now: number): boolean {
    if (!isUsableRssi(sighting.rssi)) return false;
    const loss = estimateLoss(sighting, this.receiver, this.calibration);
    const track = this.tracks.get(sighting.token) ?? this.newTrack(sighting.token, now);
    track.samples.push({ loss, at: now });
    track.lastSeenAt = now;
    track.last = { rssi: sighting.rssi, loss };
    this.tracks.set(sighting.token, track);
    return true;
  }

  private newTrack(token: string, now: number): Track {
    return {
      token,
      samples: [],
      state: 'far',
      touchingSince: null,
      lastSeenAt: now,
      last: { rssi: 0, loss: Number.POSITIVE_INFINITY },
      median: null,
    };
  }

  /** Atualiza a janela e o estado de cada token no instante `now`. */
  evaluate(now: number): void {
    const { windowMs, minSamples, enterMaxLossDb, exitMinLossDb, nearMaxLossDb, holdMs } =
      this.calibration;
    for (const [token, track] of this.tracks) {
      track.samples = track.samples.filter((sample) => now - sample.at < windowMs);
      if (track.samples.length === 0) {
        if (now - track.lastSeenAt > FORGET_AFTER_MS) {
          this.tracks.delete(token);
          continue;
        }
        track.state = 'far';
        track.touchingSince = null;
        track.median = null;
        continue;
      }
      track.median =
        track.samples.length >= minSamples
          ? median(track.samples.map((sample) => sample.loss))
          : null;
      const value = track.median;
      // Poucas amostras na janela: mantém o estado até ter como decidir.
      if (value === null) continue;
      if (track.state === 'touching' || track.state === 'touched') {
        if (value > exitMinLossDb) {
          track.state = value <= nearMaxLossDb ? 'near' : 'far';
          track.touchingSince = null;
        } else if (track.state === 'touching' && now - (track.touchingSince ?? now) >= holdMs) {
          track.state = 'touched';
        }
      } else if (value <= enterMaxLossDb) {
        track.state = holdMs <= 0 ? 'touched' : 'touching';
        track.touchingSince = now;
      } else {
        track.state = value <= nearMaxLossDb ? 'near' : 'far';
      }
    }
  }

  /** O estado mais forte entre os tokens vistos (a tela não mostra de quem). */
  contact(): TouchContact {
    let best: TouchContact = 'far';
    for (const track of this.tracks.values()) {
      if (RANK[track.state] > RANK[best]) best = track.state;
    }
    return best;
  }

  /** Os tokens em "encostado" agora. */
  touchedTokens(): Set<string> {
    const touched = new Set<string>();
    for (const track of this.tracks.values()) {
      if (track.state === 'touched') touched.add(track.token);
    }
    return touched;
  }

  /**
   * O token encostado de menor perda, ou seja, de maior RSSI neste aparelho (o único que vai no
   * relato, P8; adendo A1), ou `null`. Encostado sem mediana (poucas amostras: os celulares se
   * afastaram) não entra na disputa; sem nenhum com mediana, `null`, e o relato segue com o último
   * token relatado, em vez de cair no primeiro do mapa.
   */
  strongestTouched(): string | null {
    let best: { token: string; median: number } | null = null;
    for (const track of this.tracks.values()) {
      if (track.state !== 'touched' || track.median === null) continue;
      if (best === null || track.median < best.median) {
        best = { token: track.token, median: track.median };
      }
    }
    return best?.token ?? null;
  }

  /** Leitura por token, para a tela de calibração (só em dev). */
  readings(): TouchReading[] {
    return [...this.tracks.values()].map((track) => ({
      token: track.token,
      state: track.state,
      rssi: track.last.rssi,
      loss: track.last.loss,
      median: track.median,
      samples: track.samples.length,
    }));
  }

  clear(): void {
    this.tracks.clear();
  }
}
