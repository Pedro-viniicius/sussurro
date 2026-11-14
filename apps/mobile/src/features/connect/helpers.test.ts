import { COPY, firstName, formatConnectedDate, formatCountdown } from './copy';
import { isSimulationEnabled } from './dev-tools';
import { haltReasonFor, isRepeatableFailure } from './errors';
import { savePendingQrToken, takePendingQrToken } from './pending-qr-link';
import { connectTiming } from './timing';
import { nfcRoleOf } from './useConnectSession';
import { UNAVAILABLE_NFC_CAPABILITIES } from '../../../modules/sussurro-proximity';
import {
  IPHONE_NFC_CAPABILITIES,
  READY_NFC_CAPABILITIES,
} from '../../../modules/sussurro-proximity/src/fake-nfc';
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

  it('PROX-68: falha repetível — sem rede, o prazo e 5xx; 429, 403, 400, 409 e 404 não', () => {
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

  it('NFC-03 (ADR 0013 §5): o papel do NFC — Android com HCE emite e lê; iPhone só lê; sem o módulo ou sem NFC, nenhum', () => {
    expect(nfcRoleOf(READY_NFC_CAPABILITIES)).toBe('emitter');
    // Desligado continua "emitter": a tela mostra "Ligar NFC".
    expect(nfcRoleOf({ ...READY_NFC_CAPABILITIES, enabled: false })).toBe('emitter');
    expect(nfcRoleOf(IPHONE_NFC_CAPABILITIES)).toBe('reader');
    expect(nfcRoleOf(UNAVAILABLE_NFC_CAPABILITIES)).toBe('none');
    expect(nfcRoleOf({ ...READY_NFC_CAPABILITIES, supported: false })).toBe('none');
    expect(nfcRoleOf({ ...READY_NFC_CAPABILITIES, available: false })).toBe('none');
    expect(nfcRoleOf({ ...READY_NFC_CAPABILITIES, canRead: false, canEmit: false })).toBe('none');
  });

  it('NFC-08: textos novos sem jargão (token, varredura, proximidade, Bluetooth, sinal)', () => {
    const visible = [
      COPY.intro,
      COPY.modeShow,
      COPY.modeRead,
      COPY.qrHint,
      COPY.emitHint,
      COPY.waitingEmitHint('Caio'),
      COPY.nfcOffTitle,
      COPY.nfcOffText,
      COPY.readNfcTitle,
      COPY.readNfcText,
      COPY.readIphoneText,
      COPY.nfcReadFailed,
      COPY.cardCheck,
      COPY.cardExpired('Caio'),
      COPY.notConfirmedText,
      COPY.notTheirCode('Helena'),
      COPY.acceptRead('Helena'),
      COPY.acceptReadNfc('Helena'),
      COPY.turnOnNfcHint,
    ];
    for (const text of visible) {
      expect(text).not.toMatch(/sinal|dist[âa]ncia|token|varredura|proximidade|bluetooth/i);
    }
    // Textos revisados pelo `ux-ui` e aprovados pelo PO (ux.md §11.19, N6 a N24).
    expect(COPY.emitHint).toBe(
      'Ou a outra pessoa toca em Ler código e encosta o celular nas costas deste.',
    );
    expect(COPY.waitingEmitHint('Caio')).toBe(
      'Ou Caio toca em Aceitar e encosta o celular nas costas deste.',
    );
    expect(COPY.nfcOffText).toBe(
      'Ligue o NFC para trocar o código encostando os celulares, ou use o QR code.',
    );
    expect(COPY.readNfcTitle).toBe('Encoste este celular no outro, costas com costas');
    expect(COPY.readNfcText).toBe(
      'O outro celular precisa estar mostrando o código na tela Conectar. Se ele for iPhone, use a câmera.',
    );
    expect(COPY.readIphoneText).toBe(
      'Se o outro celular for Android, toque em Aproximar do outro celular e encoste o topo do seu iPhone nas costas dele. Se for iPhone, use a câmera.',
    );
    expect(COPY.readIphoneText).toContain(COPY.nfcTap);
    expect(COPY.turnOnNfc).toBe('Ligar NFC');
    expect(COPY.turnOnNfcHint).toBe('Abre os ajustes do celular');
    expect(COPY.nfcOffTitle).toBe('O NFC está desligado');
    expect(COPY.nfcTap).toBe('Aproximar do outro celular');
    expect(COPY.useCamera).toBe('Usar a câmera');
    expect(COPY.nfcReadFailed).toBe('Não deu para ler o código. Tente de novo ou use a câmera.');
    expect(COPY.cardExpired('Caio')).toBe('O código de Caio venceu. Leia o código de novo.');
    expect(COPY.notTheirCode('Helena')).toBe(
      'Este código não é de Helena ou já venceu. Leia o código na tela de Helena.',
    );
    expect(COPY.acceptReadNfc('Helena')).toBe(
      'Ou encoste este celular no de Helena, costas com costas. Com iPhone, só a câmera funciona.',
    );
    expect(COPY.connectWith('Caio')).toBe('Conectar com Caio');
    expect(COPY.connectWithLabel('Caio Ribeiro', 'caio.r')).toBe(
      'Conectar com Caio Ribeiro, @caio.r',
    );
  });

  it('4.11 CA3: as simulações só no build de desenvolvimento em modo dev', () => {
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
