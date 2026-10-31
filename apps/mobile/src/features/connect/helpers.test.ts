import { ProximityTokenValueSchema } from '@sussurro/shared';

import { csvLine, localCalibrationToken } from './CalibrationScreen';
import { COPY, firstName, formatConnectedDate, formatCountdown } from './copy';
import { isSimulationEnabled } from './dev-tools';
import { haltReasonFor } from './errors';
import { savePendingQrToken, takePendingQrToken } from './pending-qr-link';
import { connectTiming } from './timing';
import { capabilityView } from './useConnectSession';
import { READY_CAPABILITIES } from '../../../modules/sussurro-proximity/src/fake-radio';
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

  it('erros que param a tela (ux.md §5.2): 429, Redis fora, criador, sem rede e e-mail', () => {
    expect(haltReasonFor(new ApiError(429, 'RATE_LIMITED', 'x'))).toBe('paused');
    expect(haltReasonFor(new ApiError(503, 'PROXIMITY_UNAVAILABLE', 'x'))).toBe('unavailable');
    expect(haltReasonFor(new ApiError(500, 'INTERNAL_ERROR', 'x'))).toBe('unavailable');
    expect(haltReasonFor(new ApiError(403, 'ACCOUNT_TYPE_NOT_ALLOWED', 'x'))).toBe('unavailable');
    expect(haltReasonFor(new NetworkError())).toBe('offline');
    expect(haltReasonFor(new ApiError(403, 'EMAIL_NOT_VERIFIED', 'x'))).toBe('emailNotVerified');
    expect(haltReasonFor(new ApiError(400, 'PROXIMITY_TOKEN_INVALID', 'x'))).toBeNull();
    expect(haltReasonFor(new ApiError(400, 'VALIDATION_ERROR', 'x'))).toBeNull();
    expect(haltReasonFor(new ApiError(409, 'ALREADY_CONNECTED', 'x'))).toBeNull();
  });

  it('ux.md §11.4: o estado de cada combinação de capacidades (2 a 5)', () => {
    const ready = READY_CAPABILITIES;
    expect(capabilityView(ready)).toBe('ready');
    expect(capabilityView({ ...ready, permission: 'undetermined' })).toBe('btExplain');
    expect(capabilityView({ ...ready, permission: 'denied', canAskAgain: true })).toBe('btExplain');
    expect(capabilityView({ ...ready, permission: 'undetermined' }, { afterRequest: true })).toBe(
      'btDenied',
    );
    expect(capabilityView({ ...ready, permission: 'denied', canAskAgain: false })).toBe('btDenied');
    expect(capabilityView({ ...ready, bluetooth: 'off' })).toBe('btOff');
    expect(capabilityView({ ...ready, locationServices: 'off' })).toBe('btLocationOff');
    expect(capabilityView({ ...ready, locationServices: 'on' })).toBe('ready');
    // P6: sem BLE, sem o módulo ou sem anunciar, o encostar não funciona: vai para o QR.
    expect(capabilityView({ ...ready, canAdvertise: false })).toBe('unsupported');
    expect(capabilityView({ ...ready, available: false })).toBe('unsupported');
    expect(capabilityView({ ...ready, bleSupported: false })).toBe('unsupported');
  });

  it('T43, T44 e T45 (aprovados pelo PO em 2026-10-30): a redação exata', () => {
    expect(COPY.privacyNote).toBe(
      'Seu nome e sua foto só aparecem quando os dois celulares percebem o encosto, e você vê a outra pessoa na mesma hora.',
    );
    expect(COPY.btExplainText).toBe(
      'O Sussurro usa o Bluetooth só para perceber quando o seu celular encosta no de outra pessoa. Seu nome e sua foto não passam pelo Bluetooth, e nada é transmitido com o app fechado.',
    );
    expect(COPY.acceptFailed('Helena')).toBe(
      'Não foi possível confirmar agora. Leia o código de Helena de novo.',
    );
  });

  it('T1 a T45: textos aprovados, sem jargão (sinal, distância, NFC, token, varredura, proximidade)', () => {
    const visible = [
      COPY.intro,
      COPY.modeTouch,
      COPY.readyTitle,
      COPY.readyText,
      COPY.privacyNote,
      COPY.approachingTitle,
      COPY.approachingText,
      COPY.confirmingTitle,
      COPY.confirmingText,
      COPY.touchFailed,
      COPY.nobodyTitle,
      COPY.nobodyText,
      COPY.cardCheck,
      COPY.cardExpired('Caio'),
      COPY.notConfirmedText('ble'),
      COPY.pausedText,
      COPY.btExplainText,
      COPY.btExplainLegacy,
      COPY.btDeniedText,
      COPY.btOffText,
      COPY.locationOffText,
      COPY.btUnavailableTitle,
      COPY.unsupportedBanner,
      COPY.qrExplain,
      COPY.qrHint,
      COPY.notSeen('Helena'),
      COPY.acceptFailed('Helena'),
    ];
    for (const text of visible) {
      expect(text).not.toMatch(/sinal|dist[âa]ncia|NFC|token|varredura|proximidade|an[úu]ncio/i);
    }
    expect(COPY.connectWith('Caio')).toBe('Conectar com Caio');
    expect(COPY.connectWithLabel('Caio Ribeiro', 'caio.r')).toBe(
      'Conectar com Caio Ribeiro, @caio.r',
    );
    expect(COPY.readTheirCode).toBe('Ler o código da outra pessoa');
  });

  it('4.11 CA3: as simulações e a calibração só no build de desenvolvimento em modo dev', () => {
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

  it('calibração (dev): token local bem formado e a linha CSV do Metro', () => {
    expect(ProximityTokenValueSchema.safeParse(localCalibrationToken()).success).toBe(true);
    expect(localCalibrationToken(() => 0)).toBe('AAAAAAAAAAAAAAAA');
    expect(
      csvLine(
        1000,
        { platform: 'android', model: 'Pixel 9' },
        {
          token: 'CaioTokenBBBBBB1',
          state: 'touched',
          rssi: -30,
          loss: 30,
          median: 30.5,
          samples: 7,
        },
      ),
    ).toBe('prox-csv,1000,android,Pixel 9,CaioTo,-30,30.0,30.5,touched');
  });
});
