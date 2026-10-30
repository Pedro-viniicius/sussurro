import { NearbyTracker, signalBand } from './nearby';
import { RECENT_TTL_MS, TOKEN_TTL_MS } from './timing';
import { nearbyPerson } from '../../test-utils/connect-fixtures';

const T0 = 1_000_000;

function tokenOf(n: number): string {
  return `Token${String(n).padStart(11, '0')}`;
}

describe('faixas de distância (D13, arquitetura.md §11.2)', () => {
  it('acima de -60 dBm "bem perto"; de -60 a -90 "por perto"; abaixo de -90 esconde', () => {
    expect(signalBand(-40)).toBe('bem perto');
    expect(signalBand(-59)).toBe('bem perto');
    expect(signalBand(-60)).toBe('por perto');
    expect(signalBand(-75)).toBe('por perto');
    expect(signalBand(-90)).toBe('por perto');
    expect(signalBand(-91)).toBeNull();
  });
});

describe('NearbyTracker ("Por perto agora", 4.4)', () => {
  it('4.4 CA8: lista ordenada pelo sinal suavizado, com a faixa; abaixo de -90 não aparece', () => {
    const tracker = new NearbyTracker();
    tracker.record('CaioTokenBBBBBB1', -70, T0);
    tracker.record('BiaTokenCCCCCCC1', -50, T0);
    tracker.record('LongeTokenEEEEE1', -95, T0);
    const sent = tracker.takePending();
    tracker.applyResolve(sent, [
      nearbyPerson(),
      nearbyPerson({ token: 'BiaTokenCCCCCCC1', handle: 'bia.alves', name: 'Bianca Alves' }),
      nearbyPerson({ token: 'LongeTokenEEEEE1', handle: 'longe', name: 'Longe' }),
    ]);

    const rows = tracker.rows(T0, 10_000);
    expect(rows.map((row) => [row.handle, row.band])).toEqual([
      ['bia.alves', 'bem perto'],
      ['caio.r', 'por perto'],
    ]);

    // A média das últimas leituras muda a ordem: Caio chega mais perto.
    for (let i = 1; i <= 5; i += 1) tracker.record('CaioTokenBBBBBB1', -45, T0 + i * 100);
    expect(tracker.rows(T0 + 600, 10_000)[0]?.handle).toBe('caio.r');
  });

  it('4.4 CA4: quem já é conexão vem marcado; a pessoa some depois de um tempo sem anúncio', () => {
    const tracker = new NearbyTracker();
    tracker.record('CaioTokenBBBBBB1', -55, T0);
    tracker.applyResolve(tracker.takePending(), [nearbyPerson({ alreadyConnected: true })]);
    expect(tracker.rows(T0, 10_000)[0]?.alreadyConnected).toBe(true);
    expect(tracker.rows(T0 + 10_001, 10_000)).toEqual([]);
  });

  it('PROX-25: a pessoa junta os tokens novos e o pedido usa o mais recente ainda válido', () => {
    const tracker = new NearbyTracker();
    tracker.record('CaioTokenBBBBBB1', -60, T0);
    tracker.applyResolve(tracker.takePending(), [nearbyPerson()]);
    // 20 s depois o token de Caio mudou; o resolve diz que é a mesma pessoa.
    tracker.record('CaioTokenBBBBBB2', -60, T0 + 20_000);
    tracker.applyResolve(tracker.takePending(), [nearbyPerson({ token: 'CaioTokenBBBBBB2' })]);
    expect(tracker.rows(T0 + 20_000, 10_000)).toHaveLength(1);
    expect(tracker.latestToken('caio.r', T0 + 21_000, TOKEN_TTL_MS)).toBe('CaioTokenBBBBBB2');
    // Passados 30 s da primeira vista do token mais novo, nenhum vale mais para pedir.
    expect(tracker.latestToken('caio.r', T0 + 20_000 + TOKEN_TTL_MS, TOKEN_TTL_MS)).toBeNull();
    // Para o aceite (PROX-26), a janela é de 120 s.
    expect(tracker.latestToken('caio.r', T0 + 100_000, RECENT_TTL_MS)).toBe('CaioTokenBBBBBB2');
  });

  it('"saiu de perto": a linha some até aparecer um token novo da pessoa', () => {
    const tracker = new NearbyTracker();
    tracker.record('CaioTokenBBBBBB1', -60, T0);
    tracker.applyResolve(tracker.takePending(), [nearbyPerson()]);
    tracker.forget('caio.r');
    tracker.record('CaioTokenBBBBBB1', -60, T0 + 500);
    expect(tracker.rows(T0 + 500, 10_000)).toEqual([]);
    expect(tracker.hasPending()).toBe(false);
    expect(tracker.record('CaioTokenBBBBBB2', -60, T0 + 1_000)).toBe(true);
    expect(tracker.hasPending()).toBe(true);
  });

  it('resolve em lote: no máximo 20 tokens por chamada; token que não resolve não volta', () => {
    const tracker = new NearbyTracker();
    for (let i = 0; i < 25; i += 1) tracker.record(tokenOf(i), -60, T0 + i);
    const first = tracker.takePending();
    expect(first).toHaveLength(20);
    // Os vistos por último vão primeiro.
    expect(first[0]).toBe(tokenOf(24));
    tracker.applyResolve(first, []);
    const second = tracker.takePending();
    expect(second).toHaveLength(5);
    // Falha passageira: os tokens voltam para a fila.
    tracker.release(second);
    expect(tracker.takePending()).toHaveLength(5);
    expect(tracker.takePending()).toEqual([]);
  });
});
