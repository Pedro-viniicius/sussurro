import {
  PROXIMITY_TOUCH_PAIR_TTL_S,
  PROXIMITY_TOUCH_REPORT_FOR_S,
  PROXIMITY_TOUCH_REPORT_INTERVAL_S,
} from '@sussurro/shared';

import type { AdvertiseTxPower } from '../../../modules/sussurro-proximity';

/**
 * **Ponto único de calibração** do "encostar" (ADR 0012 §2 e §8, adendo A1; arquitetura.md §11.6).
 * Tudo o que decide se dois celulares estão encostados mora aqui: o nativo só recebe a potência do
 * anúncio e o intervalo entre eventos, e o detector (`touch-detector.ts`) só aplica os limiares.
 * Nada que o emissor declare entra na conta (A1). Nada daqui vai para o servidor: o app afirma só
 * "encostado" (PROX-43).
 *
 * Os valores são os **provisórios** da ADR 0012 §2: dão um ponto de partida ao código. O spike
 * 4.1-B mede os aparelhos da matriz (com a tela `/dev/proximidade`) e substitui os números, com a
 * data, os aparelhos e a versão em `measured`. Sem `expo-updates`, mudar a calibração exige build
 * novo (decisão 6 do PO).
 */
export interface TouchCalibration {
  /** De onde vêm os números (o spike 4.1-B preenche). */
  readonly measured: {
    readonly at: string | null;
    readonly devices: string;
    readonly note: string;
  };
  readonly android: {
    /**
     * Potência do anúncio no Android, perto da do iPhone (que não dá para baixar), para o limiar
     * único pegar no encosto o emissor honesto mais fraco (ADR 0012, adendo A1). O anúncio nunca
     * leva o campo TX Power.
     */
    readonly advertiseTxPower: AdvertiseTxPower;
  };
  /**
   * Referência única de todo emissor (dBm); nunca vem do anúncio (ADR 0012, adendo A1). O campo TX
   * Power é um número que o emissor escreve e o receptor não tem como conferir: com ele na conta,
   * um anúncio forjado virava "encostado" a metros de distância.
   */
  readonly advertiserTxDbm: number;
  /** Correção de quem recebe, por plataforma (perda = `advertiserTxDbm` − RSSI − correção). */
  readonly rxCorrectionDb: { readonly ios: number; readonly android: number };
  /** Correção por modelo de quem recebe (só os outliers medidos), pelo modelo do nativo. */
  readonly modelCorrectionDb: Readonly<Record<string, number>>;
  /** No máximo 1 evento por UUID a cada `sightingMinIntervalMs` (parâmetro do nativo). */
  readonly sightingMinIntervalMs: number;
  /** Janela da mediana e o mínimo de amostras nela. */
  readonly windowMs: number;
  readonly minSamples: number;
  /** Perda (dB) para entrar em "encostando". */
  readonly enterMaxLossDb: number;
  /** Perda (dB) acima da qual sai de "encostando/encostado" (histerese). */
  readonly exitMinLossDb: number;
  /** Perda (dB) da faixa "quase" ("aproxime mais"). */
  readonly nearMaxLossDb: number;
  /** Tempo sustentado em "encostando" até virar "encostado". */
  readonly holdMs: number;
  /**
   * Relato ao servidor (ADR 0012, A2 rev. 1, R1-3): um por vez no processo inteiro, com pelo menos
   * `reportEveryMs` entre os inícios, até um prazo único que só cresce: `reportForMs` depois de cada
   * encosto admitido e da resposta de cada relato aceito de token novo. O `reportForMs` é contrato
   * com o servidor (`PROXIMITY_TOUCH_REPORT_FOR_S`), não calibração do spike: precisa ser pelo menos
   * a janela do casamento + 2 s, para quem foi visto relatar de novo depois do último casamento
   * possível e receber o cartão de quem o viu (R1-2).
   */
  readonly reportEveryMs: number;
  readonly reportForMs: number;
  /**
   * Orçamento de relatos (R1-3 item 5; variante C e BAIXO 5): o teto que o app nunca atinge em
   * qualquer janela de 60 s, no máximo 2/3 do limite do servidor (`PROXIMITY_TOUCH_LIMIT_PER_MIN`).
   * Contrato com o servidor, não calibração do spike.
   */
  readonly reportBudgetPerMinute: number;
  /**
   * Reserva do orçamento para os relatos de que um prazo já aberto ainda precisa (pelo menos
   * `ceil(reportForMs / reportEveryMs) + 1`). Um encosto novo, ou um token que pode contar como novo,
   * só entra com no máximo `reportBudgetPerMinute − reportReserve` inícios nos últimos 60 s; o relato
   * de cobertura nunca é recusado.
   */
  readonly reportReserve: number;
  /** A tela avisa "Não deu para confirmar" (o relato continua até `reportForMs`). */
  readonly confirmWarnAfterMs: number;
  /** QR em destaque (P9): 20 s no Pronto sem encostar, 10 s em "quase" ou 2 falhas seguidas. */
  readonly noTouchFallbackMs: number;
  readonly nearFallbackMs: number;
  readonly failuresBeforeQr: number;
  /** O app tira o cartão 5 s antes do fim do par no servidor (60 s), para o pedido não vencer. */
  readonly cardTtlMarginMs: number;
  /**
   * P7: no Android, a varredura começa uns 500 ms depois de abrir a aba, para abrir e fechar a aba
   * várias vezes não esbarrar no limite de cerca de 5 inícios em 30 s. O iOS não tem o limite.
   */
  readonly scanStartDelayMs: { readonly ios: number; readonly android: number };
}

/** Valores iniciais da ADR 0012 §2 e do adendo A1 (provisórios até o spike 4.1-B). */
export const TOUCH_CALIBRATION: TouchCalibration = {
  measured: {
    at: null,
    devices: '',
    note: 'Valores provisórios da ADR 0012 §2; o spike 4.1-B substitui.',
  },
  android: { advertiseTxPower: 'high' },
  advertiserTxDbm: 0,
  rxCorrectionDb: { ios: 0, android: 0 },
  modelCorrectionDb: {},
  sightingMinIntervalMs: 200,
  windowMs: 1500,
  minSamples: 3,
  enterMaxLossDb: 40,
  exitMinLossDb: 46,
  nearMaxLossDb: 52,
  holdMs: 700,
  reportEveryMs: PROXIMITY_TOUCH_REPORT_INTERVAL_S * 1000,
  reportForMs: PROXIMITY_TOUCH_REPORT_FOR_S * 1000,
  reportBudgetPerMinute: 40,
  reportReserve: 10,
  confirmWarnAfterMs: 4000,
  noTouchFallbackMs: 20_000,
  nearFallbackMs: 10_000,
  failuresBeforeQr: 2,
  cardTtlMarginMs: 5000,
  scanStartDelayMs: { ios: 0, android: 500 },
};

/** Quanto o cartão vale no app: o par do servidor (60 s) menos a margem (55 s, P4). */
export function cardTtlMs(calibration: TouchCalibration = TOUCH_CALIBRATION): number {
  return PROXIMITY_TOUCH_PAIR_TTL_S * 1000 - calibration.cardTtlMarginMs;
}

/**
 * Quando o cartão vence no app (P4; PROX-64): `chegada + min(cardTtlMs, pairExpiresInS × 1000)`.
 * O `pairExpiresInS` vem do servidor, em cada cartão do `touches`: o que falta para o par vencer lá,
 * arredondado para baixo em múltiplos de 5 s (55 no casamento na hora). O arredondamento já é a
 * margem: o valor nunca passa do tempo que de fato resta, então o app não desconta a margem de novo.
 * Um cartão devido que chega tarde (rede lenta, com um relato em voo) vence antes, e o app nunca
 * mostra "Conectar", "Bloquear" ou "Denunciar" depois que o par acabou no servidor (ux.md §11.14,
 * ponto para o `arquiteto`).
 */
export function cardExpiresAt(
  arrivedAt: number,
  pairExpiresInS: number,
  calibration: TouchCalibration = TOUCH_CALIBRATION,
): number {
  return arrivedAt + Math.max(0, Math.min(cardTtlMs(calibration), pairExpiresInS * 1000));
}
