import { ProximityTokenValueSchema } from '@sussurro/shared';

import { csvLine, localCalibrationToken } from './CalibrationScreen';
import { COPY, firstName, formatConnectedDate, formatCountdown } from './copy';
import { isSimulationEnabled } from './dev-tools';
import { haltReasonFor, isRepeatableFailure } from './errors';
import { savePendingQrToken, takePendingQrToken } from './pending-qr-link';
import { connectTiming } from './timing';
import {
  capabilityView,
  type CardPlacement,
  cardVariantOf,
  type ConnectView,
  placeCard,
} from './useConnectSession';
import type { TouchCard } from './useTouch';
import { READY_CAPABILITIES } from '../../../modules/sussurro-proximity/src/fake-radio';
import { ApiError, NetworkError } from '../../lib/api/errors';
import { connectionRequest, nearbyPerson } from '../../test-utils/connect-fixtures';

function touchCard(overrides: Partial<TouchCard> = {}): TouchCard {
  return {
    person: nearbyPerson(),
    matchedAt: 1_000,
    actionsUntil: 56_000,
    late: false,
    canConnect: true,
    ...overrides,
  };
}

const BIA = { handle: 'bia.alves', name: 'Bianca Alves', avatarUrl: null };

describe('Conectar: qual cartão aparece e onde (ux.md §11.15)', () => {
  it('PROX-70: a ordem de escolha — Bloqueado → 14 → 12 → 21 → 22 → 11', () => {
    const all = { card: touchCard({ late: true, canConnect: false }), alreadyConnected: true };
    expect(cardVariantOf(all, { blocked: true, request: true })).toBe('blocked');
    expect(cardVariantOf(all, { blocked: false, request: true })).toBe('incoming');
    // O 12, mesmo atrasado ou sem Conectar: o bloqueio e a denúncia dele não dependem do par.
    expect(cardVariantOf(all, { blocked: false, request: false })).toBe('alreadyConnected');
    const late = { card: touchCard({ late: true, canConnect: false }), alreadyConnected: false };
    expect(cardVariantOf(late, { blocked: false, request: false })).toBe('late');
    const noConnect = { card: touchCard({ canConnect: false }), alreadyConnected: false };
    expect(cardVariantOf(noConnect, { blocked: false, request: false })).toBe('noConnect');
    const touched = { card: touchCard(), alreadyConnected: false };
    expect(cardVariantOf(touched, { blocked: false, request: false })).toBe('touched');
    // O 14 e o Bloqueado também a partir do 21 e do 22.
    expect(cardVariantOf(late, { blocked: false, request: true })).toBe('incoming');
    expect(cardVariantOf(noConnect, { blocked: true, request: false })).toBe('blocked');
  });

  it.each<[string, ConnectView, boolean, CardPlacement]>([
    ['Verificando (1)', { kind: 'checking' }, false, 'show'],
    ['Pronto (6 a 10)', { kind: 'ready' }, false, 'show'],
    ['explicação do Bluetooth (2)', { kind: 'btExplain' }, false, 'show'],
    ['Bluetooth negado (3)', { kind: 'btDenied' }, false, 'show'],
    ['Bluetooth desligado (4)', { kind: 'btOff' }, false, 'show'],
    ['localização desligada (4b)', { kind: 'btLocationOff' }, false, 'show'],
    ['EmptyState do Sem suporte (5)', { kind: 'btUnsupported' }, false, 'show'],
    ['QR com uma leitura em andamento', { kind: 'checking' }, true, 'wait'],
    [
      'Aguardando (13) de outra pessoa',
      { kind: 'waiting', request: connectionRequest({ other: { ...BIA } }) },
      false,
      'wait',
    ],
    [
      'Aguardando (13) da mesma pessoa',
      { kind: 'waiting', request: connectionRequest() },
      false,
      'discard',
    ],
    [
      'Não confirmado (16) de outra pessoa',
      { kind: 'notConfirmed', request: connectionRequest({ other: { ...BIA } }) },
      false,
      'wait',
    ],
    [
      'Não confirmado (16) da mesma pessoa',
      { kind: 'notConfirmed', request: connectionRequest() },
      false,
      'discard',
    ],
    ['Conectados (15) de outra pessoa', { kind: 'connected', other: BIA, at: 0 }, false, 'wait'],
    [
      'Conectados (15) da mesma pessoa',
      {
        kind: 'connected',
        other: { handle: 'caio.r', name: 'Caio Ribeiro', avatarUrl: null },
        at: 0,
      },
      false,
      'discard',
    ],
    [
      'outro cartão na tela',
      {
        kind: 'card',
        card: touchCard({ person: nearbyPerson({ handle: 'bia.alves', name: 'Bianca Alves' }) }),
        alreadyConnected: false,
      },
      false,
      'wait',
    ],
    [
      'o cartão da mesma pessoa na tela',
      { kind: 'card', card: touchCard(), alreadyConnected: false },
      false,
      'discard',
    ],
  ])('PROX-69: o cartão que chega com %s → %s', (_case, view, reading, expected) => {
    expect(placeCard(touchCard(), { halted: false, view, reading })).toBe(expected);
  });

  it('PROX-69: com a tela parada (18 a 20), o cartão é descartado em qualquer estado', () => {
    for (const view of [{ kind: 'checking' }, { kind: 'ready' }] as const) {
      expect(placeCard(touchCard(), { halted: true, view, reading: false })).toBe('discard');
    }
  });
});

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

  it('PROX-68: falha repetível (A3-3 item 2) — sem rede, o prazo e 5xx; 429, 403, 400, 409 e 404 não', () => {
    expect(isRepeatableFailure(new NetworkError())).toBe(true);
    expect(isRepeatableFailure(new NetworkError(new Error('Sem resposta em 4000 ms')))).toBe(true);
    expect(isRepeatableFailure(new ApiError(503, 'PROXIMITY_UNAVAILABLE', 'x'))).toBe(true);
    expect(isRepeatableFailure(new ApiError(503, 'SERVICE_UNAVAILABLE', 'x'))).toBe(true);
    expect(isRepeatableFailure(new ApiError(500, 'INTERNAL_ERROR', 'x'))).toBe(true);
    expect(isRepeatableFailure(new ApiError(429, 'RATE_LIMITED', 'x'))).toBe(false);
    expect(isRepeatableFailure(new ApiError(403, 'ACCOUNT_TYPE_NOT_ALLOWED', 'x'))).toBe(false);
    expect(isRepeatableFailure(new ApiError(403, 'EMAIL_NOT_VERIFIED', 'x'))).toBe(false);
    expect(isRepeatableFailure(new ApiError(400, 'PROXIMITY_TOKEN_INVALID', 'x'))).toBe(false);
    expect(isRepeatableFailure(new ApiError(409, 'PROXIMITY_SCREEN_CLOSED', 'x'))).toBe(false);
    expect(isRepeatableFailure(new ApiError(404, 'NOT_FOUND', 'x'))).toBe(false);
    // Resposta fora do contrato (o schema recusou): não é rede, para na hora ("indisponível").
    expect(isRepeatableFailure(new Error('schema'))).toBe(false);
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

  it('PROX-70: T47 e T48 (propostos, a aprovar pelo PO, A3-PO-2) — a redação exata da ux.md §11.9', () => {
    expect(COPY.lateCardText('Caio')).toBe(
      'O tempo para conectar acabou. Para tentar de novo, toque em Voltar e encoste o seu celular no de Caio.',
    );
    expect(COPY.noConnectCardText('Caio')).toBe(
      'Para conectar, toque em Voltar e encoste de novo o seu celular no de Caio.',
    );
  });

  it('T1 a T48: textos sem jargão (sinal, distância, NFC, token, varredura, proximidade)', () => {
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
      COPY.lateCardText('Caio'),
      COPY.noConnectCardText('Caio'),
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
