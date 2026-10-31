import { cardTtlMs, TOUCH_CALIBRATION, type TouchCalibration } from './touch-calibration';
import {
  estimateLoss,
  isUsableRssi,
  median,
  TouchDetector,
  type TouchReceiver,
  type TouchSighting,
} from './touch-detector';

const IPHONE: TouchReceiver = { platform: 'ios', model: 'iPhone15,2' };
const ANDROID: TouchReceiver = { platform: 'android', model: 'Pixel 9' };
const CAL = TOUCH_CALIBRATION;

/**
 * RSSI que dá a perda pedida num receptor sem correção (perda = `advertiserTxDbm` − RSSI). Com a
 * referência única 0 do adendo A1, é só `-perda`.
 */
function rssiForLoss(loss: number): number {
  return CAL.advertiserTxDbm - loss;
}

/** Leituras a cada 200 ms (o `sightingMinIntervalMs`) com a mesma perda, avaliando a cada uma. */
function feed(detector: TouchDetector, token: string, loss: number, from: number, until: number) {
  for (let at = from; at <= until; at += CAL.sightingMinIntervalMs) {
    detector.record({ token, rssi: rssiForLoss(loss) }, at);
    detector.evaluate(at);
  }
}

/**
 * Um avistamento como viria de um JS ou nativo antigo, com o campo TX Power declarado pelo emissor
 * (`undefined` = sem o campo). O cast simula a prop extra que o tipo não tem mais (adendo A1).
 */
function declaring(token: string, rssi: number, txPower: number | undefined): TouchSighting {
  const fromJs: Record<string, unknown> = { token, rssi };
  if (txPower !== undefined) fromJs.txPower = txPower;
  return fromJs as unknown as TouchSighting;
}

/** Os campos que um atacante declararia (sem o campo = `undefined`). */
const DECLARED_FIELDS = [-127, -100, -40, 20, undefined] as const;

describe('touch-calibration (ADR 0012 §2 e adendo A1): o ponto único com os valores provisórios', () => {
  it('os valores iniciais: Android em HIGH sem o campo TX, referência única 0 dBm, mediana em 1,5 s, 0,7 s sustentado, histerese de 6 dB', () => {
    expect(CAL.android).toStrictEqual({ advertiseTxPower: 'high' });
    expect(CAL.advertiserTxDbm).toBe(0);
    // A1: saem as chaves do campo TX declarado pelo emissor.
    expect(CAL.android).not.toHaveProperty('includeTxPowerField');
    for (const key of ['trustAdvertisedTx', 'androidAdvertiserTxDbm', 'iosAdvertiserTxDbm']) {
      expect(CAL).not.toHaveProperty(key);
    }
    expect(CAL).toMatchObject({
      rxCorrectionDb: { ios: 0, android: 0 },
      modelCorrectionDb: {},
      sightingMinIntervalMs: 200,
      windowMs: 1500,
      minSamples: 3,
      enterMaxLossDb: 40,
      exitMinLossDb: 46,
      nearMaxLossDb: 52,
      holdMs: 700,
      reportEveryMs: 1000,
      reportForMs: 8000,
      confirmWarnAfterMs: 4000,
      noTouchFallbackMs: 20_000,
      nearFallbackMs: 10_000,
      failuresBeforeQr: 2,
      cardTtlMarginMs: 5000,
      scanStartDelayMs: { ios: 0, android: 500 },
    });
    expect(CAL.exitMinLossDb - CAL.enterMaxLossDb).toBe(6);
    // O cartão vence aos 55 s no app (o par vale 60 s no servidor, P4).
    expect(cardTtlMs()).toBe(55_000);
  });
});

describe('touch-detector (ADR 0012 §2 e adendo A1)', () => {
  it('perda = advertiserTxDbm − rssi − correção de quem recebe (referência única, nunca do anúncio)', () => {
    expect(estimateLoss({ rssi: -35 }, IPHONE, CAL)).toBe(35);
    expect(estimateLoss({ rssi: -35 }, ANDROID, CAL)).toBe(35);
    // Correção por plataforma de quem recebe e pelo modelo medido (só os outliers).
    const corrected: TouchCalibration = {
      ...CAL,
      rxCorrectionDb: { ios: 2, android: -3 },
      modelCorrectionDb: { 'Pixel 9': 4 },
    };
    expect(estimateLoss({ rssi: -60 }, IPHONE, corrected)).toBe(58);
    expect(estimateLoss({ rssi: -60 }, ANDROID, corrected)).toBe(59);
    // A referência é da calibração (o spike pode mudá-la), igual para todo emissor.
    const reference: TouchCalibration = { ...CAL, advertiserTxDbm: -6 };
    expect(estimateLoss({ rssi: -40 }, IPHONE, reference)).toBe(34);
  });

  it('mediana: ímpar, par e vazia (ignora os vales de multipercurso)', () => {
    expect(median([40, 90, 38])).toBe(40);
    expect(median([30, 50, 40, 20])).toBe(35);
    expect(median([])).toBeNull();
  });

  it('RSSI 127 (sem medida), positivo, zero ou abaixo de -127 é descartado', () => {
    for (const rssi of [127, 5, 0, -128, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isUsableRssi(rssi)).toBe(false);
    }
    expect(isUsableRssi(-127)).toBe(true);
    expect(isUsableRssi(-1)).toBe(true);
    const detector = new TouchDetector(CAL, IPHONE);
    expect(detector.record({ token: 'A', rssi: 127 }, 0)).toBe(false);
    expect(detector.readings()).toEqual([]);
  });

  it('longe → quase → encostando → encostado só depois de 0,7 s sustentado (com 3 amostras na janela)', () => {
    const detector = new TouchDetector(CAL, IPHONE);
    feed(detector, 'A', 60, 0, 400);
    expect(detector.contact()).toBe('far');
    feed(detector, 'A', 50, 600, 2200);
    expect(detector.contact()).toBe('near');
    // Perda de encosto: a mediana só cai abaixo de 40 quando a maioria da janela é de encosto.
    feed(detector, 'A', 35, 2400, 3000);
    expect(detector.contact()).toBe('near');
    feed(detector, 'A', 35, 3200, 3200);
    expect(detector.contact()).toBe('touching');
    expect(detector.touchedTokens().size).toBe(0);
    feed(detector, 'A', 35, 3400, 3800);
    expect(detector.contact()).toBe('touching');
    feed(detector, 'A', 35, 4000, 4000);
    expect(detector.contact()).toBe('touched');
    expect([...detector.touchedTokens()]).toEqual(['A']);
  });

  it('com menos de 3 amostras na janela, não decide (nem entra em "encostado")', () => {
    const detector = new TouchDetector(CAL, IPHONE);
    detector.record({ token: 'A', rssi: rssiForLoss(30) }, 0);
    detector.record({ token: 'A', rssi: rssiForLoss(30) }, 200);
    detector.evaluate(200);
    expect(detector.contact()).toBe('far');
    expect(detector.readings()[0]?.median).toBeNull();
  });

  it('histerese de 6 dB: encostado continua entre 40 e 46; só sai acima de 46 (para "quase" ou "longe")', () => {
    const detector = new TouchDetector(CAL, IPHONE);
    feed(detector, 'A', 30, 0, 2000);
    expect(detector.contact()).toBe('touched');
    feed(detector, 'A', 45, 2200, 4000);
    expect(detector.contact()).toBe('touched');
    feed(detector, 'A', 49, 4200, 6000);
    expect(detector.contact()).toBe('near');
    // De "quase", voltar a 45 não basta: precisa de 40 para entrar de novo.
    feed(detector, 'A', 45, 6200, 8000);
    expect(detector.contact()).toBe('near');
    feed(detector, 'A', 60, 8200, 10_000);
    expect(detector.contact()).toBe('far');
  });

  it('limites com a referência 0: RSSI -40 chega a "encostado"; RSSI -41, mesmo declarando -127, fica em "quase"', () => {
    const atLimit = new TouchDetector(CAL, IPHONE);
    for (let at = 0; at <= 2000; at += CAL.sightingMinIntervalMs) {
      atLimit.record({ token: 'A', rssi: -40 }, at);
      atLimit.evaluate(at);
    }
    expect(atLimit.contact()).toBe('touched');

    const justOver = new TouchDetector(CAL, IPHONE);
    for (let at = 0; at <= 5000; at += CAL.sightingMinIntervalMs) {
      justOver.record(declaring('A', -41, -127), at);
      justOver.evaluate(at);
      expect(justOver.touchedTokens().size).toBe(0);
    }
    // Perda 41: acima de 40 (não entra) e até 52 ("quase").
    expect(justOver.contact()).toBe('near');
    expect(justOver.readings()[0]).toMatchObject({ rssi: -41, loss: 41, state: 'near' });
  });

  it('PROX-44: campo TX declarado (-127, -100, -40, +20 ou sem campo) com RSSI -85 ou -70 nunca sai de "longe" em 5 s', () => {
    for (const txPower of DECLARED_FIELDS) {
      for (const rssi of [-85, -70]) {
        const detector = new TouchDetector(CAL, IPHONE);
        for (let at = 0; at <= 5000; at += CAL.sightingMinIntervalMs) {
          detector.record(declaring('M', rssi, txPower), at);
          detector.evaluate(at);
          expect({ txPower, rssi, at, contact: detector.contact() }).toEqual({
            txPower,
            rssi,
            at,
            contact: 'far',
          });
        }
        expect(detector.strongestTouched()).toBeNull();
        expect(detector.touchedTokens().size).toBe(0);
        // A perda é a do RSSI medido aqui, nunca a do campo.
        expect(detector.readings()[0]).toMatchObject({ loss: -rssi, state: 'far' });
      }
    }
  });

  it('PROX-44: RSSI forte de verdade (-30) chega a "encostado" depois do holdMs, com qualquer campo declarado ou sem ele', () => {
    for (const txPower of [-127, 20, undefined]) {
      const detector = new TouchDetector(CAL, IPHONE);
      let touchingAt: number | null = null;
      let touchedAt: number | null = null;
      for (let at = 0; at <= 2000; at += CAL.sightingMinIntervalMs) {
        detector.record(declaring('B', -30, txPower), at);
        detector.evaluate(at);
        if (touchingAt === null && detector.contact() === 'touching') touchingAt = at;
        if (touchedAt === null && detector.contact() === 'touched') touchedAt = at;
      }
      // Encostando com 3 amostras (400 ms); encostado só com o holdMs (700 ms) cumprido.
      expect({ txPower, touchingAt, touchedAt }).toEqual({
        txPower,
        touchingAt: 400,
        touchedAt: 1200,
      });
      expect((touchedAt ?? 0) - (touchingAt ?? 0)).toBeGreaterThanOrEqual(CAL.holdMs);
      expect(detector.strongestTouched()).toBe('B');
    }
  });

  it('PROX-44 (P8): o anúncio forjado (RSSI -70, campo -100) nunca ganha de um encosto real (RSSI -30)', () => {
    const detector = new TouchDetector(CAL, IPHONE);
    for (let at = 0; at <= 5000; at += CAL.sightingMinIntervalMs) {
      detector.record(declaring('M', -70, -100), at);
      detector.record(declaring('B', -30, undefined), at);
      detector.evaluate(at);
      expect(detector.touchedTokens().has('M')).toBe(false);
    }
    expect(detector.strongestTouched()).toBe('B');
    expect(detector.touchedTokens()).toEqual(new Set(['B']));
  });

  it('o mais forte entre os encostados (menor perda = maior RSSI aqui) é o único relatado (P8)', () => {
    const detector = new TouchDetector(CAL, IPHONE);
    for (let at = 0; at <= 2000; at += CAL.sightingMinIntervalMs) {
      detector.record({ token: 'A', rssi: rssiForLoss(38) }, at);
      detector.record({ token: 'B', rssi: rssiForLoss(31) }, at);
      detector.evaluate(at);
    }
    expect(detector.touchedTokens()).toEqual(new Set(['A', 'B']));
    expect(detector.strongestTouched()).toBe('B');
    const fresh = new TouchDetector(CAL, IPHONE);
    expect(fresh.strongestTouched()).toBeNull();
  });

  it('sem anúncio na janela volta a "longe"; token sem anúncio há 10 s é esquecido; token novo começa do zero', () => {
    const detector = new TouchDetector(CAL, IPHONE);
    feed(detector, 'A', 30, 0, 2000);
    expect(detector.contact()).toBe('touched');
    detector.evaluate(2000 + CAL.windowMs);
    expect(detector.contact()).toBe('far');
    detector.evaluate(2000 + 10_001);
    expect(detector.readings()).toEqual([]);
    // A rotação troca o token: o novo precisa de novo dos 0,7 s.
    feed(detector, 'A2', 30, 20_000, 20_400);
    expect(detector.contact()).toBe('touching');
  });

  it('leituras para a calibração: RSSI, perda, mediana, amostras e estado (sem o campo TX)', () => {
    const detector = new TouchDetector(CAL, IPHONE);
    feed(detector, 'A', 44, 0, 400);
    expect(detector.readings()).toStrictEqual([
      { token: 'A', state: 'near', rssi: -44, loss: 44, median: 44, samples: 3 },
    ]);
    detector.clear();
    expect(detector.readings()).toEqual([]);
  });
});
