import { Button, IconButton, Text, theme } from '@sussurro/ui';
import { Redirect, router, useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { COPY } from './copy';
import { isSimulationEnabled } from './dev-tools';
import { useAppActive } from './hooks';
import { useProximityRadio } from './RadioProvider';
import { connectClock } from './timing';
import { TOUCH_CALIBRATION } from './touch-calibration';
import {
  type TouchContact,
  TouchDetector,
  type TouchReading,
  type TouchReceiver,
} from './touch-detector';
import type { ProximityCapabilities } from '../../../modules/sussurro-proximity';

/** Atualização da tabela (a varredura chega a cada 200 ms por token). */
const REFRESH_MS = 500;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PLATFORM: TouchReceiver['platform'] = Platform.OS === 'android' ? 'android' : 'ios';

/**
 * Token só local para o anúncio da calibração (16 caracteres base64url, como o do servidor). Não é
 * segredo nem identifica ninguém: a calibração não fala com a API (ADR 0012 §8).
 */
export function localCalibrationToken(random: () => number = Math.random): string {
  return Array.from(
    { length: 16 },
    () => BASE64URL[Math.floor(random() * BASE64URL.length)] ?? 'A',
  ).join('');
}

/** Linha CSV do Metro: `prox-csv,horario,plataforma,modelo,token,rssi,perda,mediana,estado`. */
export function csvLine(at: number, receiver: TouchReceiver, reading: TouchReading): string {
  return [
    'prox-csv',
    at,
    receiver.platform,
    receiver.model,
    reading.token.slice(0, 6),
    reading.rssi,
    reading.loss.toFixed(1),
    reading.median === null ? '' : reading.median.toFixed(1),
    reading.state,
  ].join(',');
}

const STATE_LABEL: Record<TouchContact, string> = {
  far: 'longe',
  near: 'quase',
  touching: 'encostando',
  touched: 'encostado',
};

function format(value: number | null): string {
  return value === null ? '—' : value.toFixed(1);
}

/** Os parâmetros em vigor, como estão no `touch-calibration.ts`. */
function Parameters() {
  const cal = TOUCH_CALIBRATION;
  const rows: [string, string][] = [
    ['Origem', cal.measured.note],
    ['Android: potência do anúncio', cal.android.advertiseTxPower],
    ['Referência única de todo emissor', `${String(cal.advertiserTxDbm)} dBm`],
    [
      'Correção Rx iOS / Android',
      `${String(cal.rxCorrectionDb.ios)} / ${String(cal.rxCorrectionDb.android)} dB`,
    ],
    ['Correções por modelo', JSON.stringify(cal.modelCorrectionDb)],
    ['Intervalo entre eventos', `${String(cal.sightingMinIntervalMs)} ms`],
    ['Janela / amostras mínimas', `${String(cal.windowMs)} ms / ${String(cal.minSamples)}`],
    [
      'Entra / sai / quase',
      `${String(cal.enterMaxLossDb)} / ${String(cal.exitMinLossDb)} / ${String(cal.nearMaxLossDb)} dB`,
    ],
    ['Sustentado', `${String(cal.holdMs)} ms`],
    ['Relato', `a cada ${String(cal.reportEveryMs)} ms por ${String(cal.reportForMs)} ms`],
  ];
  return (
    <View style={styles.block} testID="calibracao-parametros">
      <Text variant="titleSm" accessibilityRole="header">
        Parâmetros
      </Text>
      {rows.map(([label, value]) => (
        <Text key={label} variant="caption" color="greyStrong">
          {`${label}: ${value}`}
        </Text>
      ))}
    </View>
  );
}

function capabilitiesText(caps: ProximityCapabilities | null): string {
  if (caps === null) return 'Conferindo o Bluetooth…';
  return [
    `módulo: ${caps.available ? 'sim' : 'não'}`,
    `Bluetooth: ${caps.bluetooth}`,
    `permissão: ${caps.permission}`,
    `anuncia: ${caps.canAdvertise ? 'sim' : 'não'}`,
    `localização: ${caps.locationServices}`,
    `modelo: ${caps.deviceModel === '' ? '—' : caps.deviceModel}`,
  ].join(' · ');
}

function isReady(caps: ProximityCapabilities | null): boolean {
  return (
    caps !== null &&
    caps.available &&
    caps.bluetooth === 'on' &&
    caps.permission === 'granted' &&
    caps.locationServices !== 'off'
  );
}

/**
 * Calibração do encostar (spike 4.1-B, ADR 0012 §8), só no build de desenvolvimento: anuncia um
 * token local, varre e mostra ao vivo, por token, o RSSI, a perda, a mediana e o estado do
 * detector, com os parâmetros atuais (sem o campo TX, que não é lido: adendo A1). Cada leitura vira
 * uma linha CSV no `console` (capturada no terminal do Metro). **Nada vai para o servidor**, e não
 * há dependência nova.
 */
export function CalibrationScreen() {
  const enabled = isSimulationEnabled();
  const radio = useProximityRadio();
  const focused = useIsFocused();
  const live = useAppActive();
  const [caps, setCaps] = useState<ProximityCapabilities | null>(null);
  const [running, setRunning] = useState(false);
  const [readings, setReadings] = useState<TouchReading[]>([]);
  const [contact, setContact] = useState<TouchContact>('far');
  const [token] = useState(() => localCalibrationToken());
  const ready = isReady(caps);
  const active = enabled && focused && live && running && ready;

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    radio
      .getCapabilities()
      .then((result) => {
        if (!cancelled) setCaps(result);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, radio]);

  const model = caps?.deviceModel ?? '';
  useEffect(() => {
    if (!active) return undefined;
    const cal = TOUCH_CALIBRATION;
    const receiver: TouchReceiver = { platform: PLATFORM, model };
    const detector = new TouchDetector(cal, receiver);
    const subscription = radio.onSighting((sighting) => {
      const now = connectClock.now();
      if (!detector.record(sighting, now)) return;
      detector.evaluate(now);
      const reading = detector.readings().find((item) => item.token === sighting.token);
      // A saída do spike é o CSV no terminal do Metro (nada vai para o servidor).
      if (reading !== undefined) console.log(csvLine(now, receiver, reading));
    });
    radio.startAdvertising(token, { txPower: cal.android.advertiseTxPower }).catch(() => undefined);
    radio.startScan({ minIntervalMs: cal.sightingMinIntervalMs }).catch(() => undefined);
    radio.setKeepScreenOn(true).catch(() => undefined);
    const ticker = setInterval(() => {
      detector.evaluate(connectClock.now());
      setReadings(detector.readings());
      setContact(detector.contact());
    }, REFRESH_MS);
    return () => {
      clearInterval(ticker);
      subscription.remove();
      radio.stopScan().catch(() => undefined);
      radio.stopAdvertising().catch(() => undefined);
      radio.setKeepScreenOn(false).catch(() => undefined);
    };
  }, [active, model, radio, token]);

  if (!enabled) return <Redirect href="/" />;

  const askPermission = () => {
    radio
      .requestPermission()
      .then(setCaps)
      .catch(() => undefined);
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID="tela-calibracao">
      <View style={styles.header}>
        <IconButton
          icon="chevron-left"
          accessibilityLabel="Voltar"
          onPress={() => {
            if (router.canGoBack()) router.back();
          }}
        />
        <Text variant="titleSm" accessibilityRole="header">
          {COPY.calibration}
        </Text>
      </View>
      <ScrollView contentContainerStyle={styles.content}>
        <Text variant="caption" color="grey" testID="calibracao-capacidades">
          {capabilitiesText(caps)}
        </Text>
        {ready ? (
          <Button
            label={running ? 'Parar' : 'Começar a medir'}
            variant={running ? 'secondary' : 'primary'}
            fullWidth
            onPress={() => {
              setRunning((value) => !value);
            }}
          />
        ) : (
          <Button label="Pedir a permissão" fullWidth onPress={askPermission} />
        )}
        <Text variant="bodyStrong" testID="calibracao-estado">
          {`Detector: ${STATE_LABEL[contact]}`}
        </Text>
        <View style={styles.block} testID="calibracao-leituras">
          {readings.length === 0 ? (
            <Text variant="caption" color="grey">
              {running ? 'Nenhum anúncio do Sussurro por perto.' : 'Parado.'}
            </Text>
          ) : (
            readings.map((reading) => (
              <Text
                key={reading.token}
                variant="caption"
                tabularNums
                testID={`calibracao-${reading.token}`}
              >
                {`${reading.token.slice(0, 6)} · RSSI ${String(reading.rssi)} · perda ${format(
                  reading.loss,
                )} · mediana ${format(reading.median)} (${String(reading.samples)}) · ${
                  STATE_LABEL[reading.state]
                }`}
              </Text>
            ))
          )}
        </View>
        <Parameters />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  header: {
    minHeight: theme.layout.headerHeight,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.space[4],
  },
  content: {
    paddingHorizontal: theme.layout.screenX,
    paddingBottom: theme.space[32],
    gap: theme.space[16],
  },
  block: { gap: theme.space[4] },
});
