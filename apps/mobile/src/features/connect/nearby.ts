import { type NearbyPerson, PROXIMITY_RESOLVE_MAX_TOKENS } from '@sussurro/shared';

import { RECENT_TTL_MS } from './timing';

/**
 * Faixas de distância (D13, arquitetura.md §11.2): acima de -60 dBm "bem perto"; de -60 a -90 "por
 * perto"; abaixo de -90 a pessoa não aparece. Calculadas só no aparelho: o RSSI nunca vai para o
 * servidor.
 */
export const SIGNAL_NEAR_ABOVE_DBM = -60;
export const SIGNAL_HIDE_BELOW_DBM = -90;

export type SignalBand = 'bem perto' | 'por perto';

export function signalBand(rssi: number): SignalBand | null {
  if (rssi > SIGNAL_NEAR_ABOVE_DBM) return 'bem perto';
  if (rssi >= SIGNAL_HIDE_BELOW_DBM) return 'por perto';
  return null;
}

/** Média móvel das últimas leituras (o RSSI varia ±6–10 dB entre leituras). */
const SMOOTHING_SAMPLES = 5;
const SAMPLE_WINDOW_MS = 10_000;
const MAX_SAMPLES_PER_TOKEN = 10;
/** Tokens sem anúncio há mais que a janela "recente" (com folga) são esquecidos. */
const FORGET_AFTER_MS = RECENT_TTL_MS + 10_000;

type TokenStatus = 'pending' | 'sent' | 'resolved' | 'unknown';

interface Sample {
  rssi: number;
  at: number;
}

interface TokenEntry {
  token: string;
  firstSeenAt: number;
  lastSeenAt: number;
  samples: Sample[];
  status: TokenStatus;
  handle: string | null;
}

interface PersonEntry {
  handle: string;
  name: string;
  avatarUrl: string | null;
  alreadyConnected: boolean;
}

/** Uma linha de "Por perto agora". */
export interface NearbyRow {
  handle: string;
  name: string;
  avatarUrl: string | null;
  alreadyConnected: boolean;
  /** RSSI suavizado (só para ordenar; nunca aparece em número). */
  rssi: number;
  band: SignalBand;
}

/**
 * Quem está por perto, a partir dos anúncios vistos na varredura (puro, com o relógio passado de
 * fora). Cada token visto vira pendente; o `resolve` em lote diz de quem é. O token de cada pessoa
 * muda a cada 20 s: a pessoa junta todos os tokens dela, e o pedido usa o mais recente (PROX-25).
 */
export class NearbyTracker {
  private readonly tokens = new Map<string, TokenEntry>();
  private readonly people = new Map<string, PersonEntry>();

  /** Um anúncio visto. `true` quando o token é novo (precisa de `resolve`). */
  record(token: string, rssi: number, now: number): boolean {
    const entry = this.tokens.get(token);
    if (entry !== undefined) {
      entry.lastSeenAt = now;
      entry.samples.push({ rssi, at: now });
      if (entry.samples.length > MAX_SAMPLES_PER_TOKEN) entry.samples.shift();
      return false;
    }
    this.tokens.set(token, {
      token,
      firstSeenAt: now,
      lastSeenAt: now,
      samples: [{ rssi, at: now }],
      status: 'pending',
      handle: null,
    });
    return true;
  }

  hasPending(): boolean {
    for (const entry of this.tokens.values()) {
      if (entry.status === 'pending') return true;
    }
    return false;
  }

  /** Até 20 tokens ainda não enviados (os vistos por último primeiro), marcados como enviados. */
  takePending(limit: number = PROXIMITY_RESOLVE_MAX_TOKENS): string[] {
    const pending = [...this.tokens.values()]
      .filter((entry) => entry.status === 'pending')
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .slice(0, limit);
    for (const entry of pending) entry.status = 'sent';
    return pending.map((entry) => entry.token);
  }

  /**
   * Resposta do `resolve`: uma linha por pessoa, com o token mais recente dela. Os outros tokens
   * enviados (vencidos, próprios, com bloqueio ou o token antigo da mesma pessoa) não voltam e não
   * são enviados de novo.
   */
  applyResolve(sent: readonly string[], items: readonly NearbyPerson[]): void {
    const byToken = new Map(items.map((item) => [item.token, item]));
    for (const token of sent) {
      const entry = this.tokens.get(token);
      if (entry === undefined) continue;
      const item = byToken.get(token);
      if (item === undefined) {
        entry.status = 'unknown';
        continue;
      }
      entry.status = 'resolved';
      entry.handle = item.handle;
      this.people.set(item.handle, {
        handle: item.handle,
        name: item.name,
        avatarUrl: item.avatarUrl,
        alreadyConnected: item.alreadyConnected,
      });
    }
  }

  /** Falha passageira (rede, 409, 5xx): os tokens voltam para a fila. */
  release(sent: readonly string[]): void {
    for (const token of sent) {
      const entry = this.tokens.get(token);
      if (entry?.status === 'sent') entry.status = 'pending';
    }
  }

  /** Falha definitiva: não reenviar. */
  discard(sent: readonly string[]): void {
    for (const token of sent) {
      const entry = this.tokens.get(token);
      if (entry?.status === 'sent') entry.status = 'unknown';
    }
  }

  private tokensOf(handle: string): TokenEntry[] {
    return [...this.tokens.values()].filter(
      (entry) => entry.status === 'resolved' && entry.handle === handle,
    );
  }

  /** Último anúncio visto da pessoa (qualquer token dela). */
  lastSeenAt(handle: string): number | null {
    const entries = this.tokensOf(handle);
    if (entries.length === 0) return null;
    return Math.max(...entries.map((entry) => entry.lastSeenAt));
  }

  isPresent(handle: string, now: number, withinMs: number): boolean {
    const last = this.lastSeenAt(handle);
    return last !== null && now - last <= withinMs;
  }

  /**
   * O token mais recente da pessoa (pela primeira vez que foi visto), se ainda puder valer: o token
   * foi emitido antes de ser visto, então passado `maxAgeMs` da primeira vista ele já venceu.
   */
  latestToken(handle: string, now: number, maxAgeMs: number): string | null {
    let best: TokenEntry | null = null;
    for (const entry of this.tokensOf(handle)) {
      if (now - entry.firstSeenAt >= maxAgeMs) continue;
      if (best === null || entry.firstSeenAt > best.firstSeenAt) best = entry;
    }
    return best?.token ?? null;
  }

  markConnected(handle: string): void {
    const person = this.people.get(handle);
    if (person !== undefined) this.people.set(handle, { ...person, alreadyConnected: true });
  }

  /** "Saiu de perto": a linha some até aparecer um token novo dela. */
  forget(handle: string): void {
    this.people.delete(handle);
    for (const entry of this.tokensOf(handle)) {
      entry.status = 'unknown';
      entry.handle = null;
    }
  }

  /** Esquece tokens antigos e pessoas sem token. */
  prune(now: number): void {
    for (const [token, entry] of this.tokens) {
      if (now - entry.lastSeenAt > FORGET_AFTER_MS) this.tokens.delete(token);
    }
    for (const handle of this.people.keys()) {
      if (this.tokensOf(handle).length === 0) this.people.delete(handle);
    }
  }

  clear(): void {
    this.tokens.clear();
    this.people.clear();
  }

  /**
   * "Por perto agora": quem foi visto nos últimos `presenceMs`, ordenado pelo sinal suavizado (do
   * mais forte ao mais fraco), com a faixa. Abaixo de -90 dBm a pessoa não aparece.
   */
  rows(now: number, presenceMs: number): NearbyRow[] {
    const rows: NearbyRow[] = [];
    for (const person of this.people.values()) {
      const entries = this.tokensOf(person.handle);
      if (entries.length === 0) continue;
      const lastSeen = Math.max(...entries.map((entry) => entry.lastSeenAt));
      if (now - lastSeen > presenceMs) continue;
      const samples = entries
        .flatMap((entry) => entry.samples)
        .filter((sample) => now - sample.at <= SAMPLE_WINDOW_MS)
        .sort((a, b) => a.at - b.at)
        .slice(-SMOOTHING_SAMPLES);
      if (samples.length === 0) continue;
      const rssi = samples.reduce((sum, sample) => sum + sample.rssi, 0) / samples.length;
      const band = signalBand(rssi);
      if (band === null) continue;
      rows.push({
        handle: person.handle,
        name: person.name,
        avatarUrl: person.avatarUrl,
        alreadyConnected: person.alreadyConnected,
        rssi,
        band,
      });
    }
    return rows.sort((a, b) => b.rssi - a.rssi || a.handle.localeCompare(b.handle));
  }
}
