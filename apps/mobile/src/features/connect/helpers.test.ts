import { firstName, formatConnectedDate, formatCountdown } from './copy';
import { isSimulationEnabled } from './dev-tools';
import { haltReasonFor } from './errors';
import { savePendingQrToken, takePendingQrToken } from './pending-qr-link';
import { connectTiming } from './timing';
import { ApiError, NetworkError } from '../../lib/api/errors';

describe('Conectar: funções auxiliares', () => {
  it('textos: primeiro nome, data do p14 e "Expira em 1:45"', () => {
    expect(firstName('Caio Ribeiro')).toBe('Caio');
    expect(firstName('  Helena  ')).toBe('Helena');
    expect(formatConnectedDate(new Date(2026, 9, 27, 15).getTime())).toBe('27 out 2026');
    expect(formatCountdown(105)).toBe('1:45');
    expect(formatCountdown(9.2)).toBe('0:10');
    expect(formatCountdown(-3)).toBe('0:00');
  });

  it('erros que param a tela (ux.md §5.2): 429, Redis fora, sem rede e e-mail', () => {
    expect(haltReasonFor(new ApiError(429, 'RATE_LIMITED', 'x'))).toBe('paused');
    expect(haltReasonFor(new ApiError(503, 'PROXIMITY_UNAVAILABLE', 'x'))).toBe('unavailable');
    expect(haltReasonFor(new ApiError(500, 'INTERNAL_ERROR', 'x'))).toBe('unavailable');
    expect(haltReasonFor(new NetworkError())).toBe('offline');
    expect(haltReasonFor(new ApiError(403, 'EMAIL_NOT_VERIFIED', 'x'))).toBe('emailNotVerified');
    expect(haltReasonFor(new ApiError(400, 'PROXIMITY_TOKEN_INVALID', 'x'))).toBeNull();
    expect(haltReasonFor(new ApiError(409, 'ALREADY_CONNECTED', 'x'))).toBeNull();
  });

  it('4.11 CA3: "Simular um pedido recebido" só no build de desenvolvimento em modo dev', () => {
    expect(isSimulationEnabled(true, 'development')).toBe(true);
    expect(isSimulationEnabled(true, 'preview')).toBe(false);
    expect(isSimulationEnabled(true, 'production')).toBe(false);
    expect(isSimulationEnabled(false, 'development')).toBe(false);
    expect(isSimulationEnabled(false, 'preview')).toBe(false);
  });

  it('PROX-24 / 4.7 CA6: deep link sem sessão guarda o token e descarta depois de 30 s', () => {
    savePendingQrToken('CaioTokenBBBBBB1', 1_000);
    expect(takePendingQrToken(1_000 + connectTiming.pendingLinkTtlMs)).toBe('CaioTokenBBBBBB1');
    // Lido uma vez, some.
    expect(takePendingQrToken(1_000)).toBeNull();

    savePendingQrToken('CaioTokenBBBBBB1', 1_000);
    expect(takePendingQrToken(1_000 + connectTiming.pendingLinkTtlMs + 1)).toBeNull();
    expect(takePendingQrToken(1_000)).toBeNull();
  });
});
