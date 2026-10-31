import { userEvent } from '@testing-library/react-native';
import { act, screen, waitFor } from 'expo-router/testing-library';

import { COPY } from './copy';
import * as devTools from './dev-tools';
import { TOUCH_CALIBRATION } from './touch-calibration';
import { createFakeRadio } from '../../../modules/sussurro-proximity/src/fake-radio';
import { renderApp } from '../../test-utils/render-app';

/** A referência única de todo emissor (adendo A1): RSSI = referência − perda. */
const TX_REF = TOUCH_CALIBRATION.advertiserTxDbm;

afterEach(() => {
  jest.restoreAllMocks();
});

describe('/dev/proximidade: calibração do encostar (spike 4.1-B, ADR 0012 §8)', () => {
  it('mostra, por token, RSSI, perda, mediana e estado (sem o campo TX, A1); escreve o CSV no console; nada vai para a API', async () => {
    jest.spyOn(devTools, 'isSimulationEnabled').mockReturnValue(true);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const radio = createFakeRadio({ deviceModel: 'Pixel 9' });
    const { api } = await renderApp({ initialUrl: '/dev/proximidade', radio });
    expect(await screen.findByTestId('tela-calibracao')).toBeOnTheScreen();
    // O título vem do `copy.ts`, o mesmo do link no Conectar.
    expect(screen.getByRole('header', { name: COPY.calibration })).toBeOnTheScreen();
    expect(await screen.findByText(/modelo: Pixel 9/)).toBeOnTheScreen();
    expect(screen.getByTestId('calibracao-parametros')).toHaveTextContent(
      /Entra \/ sai \/ quase: 40 \/ 46 \/ 52 dB/,
    );
    // Adendo A1: a potência do Android e a referência única; nada do campo TX.
    const parameters = screen.getByTestId('calibracao-parametros');
    expect(parameters).toHaveTextContent(/Android: potência do anúncio: high/);
    expect(parameters).toHaveTextContent(/Referência única de todo emissor: 0 dBm/);
    expect(parameters).not.toHaveTextContent(/campo TX|trustAdvertisedTx|TX assumido/);

    await userEvent.press(screen.getByRole('button', { name: 'Começar a medir' }));
    await waitFor(() => {
      expect(radio.scanning).toBe(true);
    });
    // Anuncia um token só local, só com a potência da calibração (sem o campo TX, A1).
    expect(radio.advertising).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(radio.advertiseOptions).toStrictEqual({
      txPower: TOUCH_CALIBRATION.android.advertiseTxPower,
    });
    expect(radio.keepScreenOn).toBe(true);

    for (let index = 0; index < 8; index += 1) {
      await act(async () => {
        radio.emitSighting('CaioTokenBBBBBB1', TX_REF - 30);
        await jest.advanceTimersByTimeAsync(200);
      });
    }
    await act(async () => {
      await jest.advanceTimersByTimeAsync(500);
    });
    expect(screen.getByTestId('calibracao-CaioTokenBBBBBB1')).toHaveTextContent(
      /CaioTo · RSSI -30 · perda 30\.0 · mediana 30\.0 \(\d\) · encostado/,
    );
    expect(screen.getByTestId('calibracao-estado')).toHaveTextContent('Detector: encostado');
    expect(log).toHaveBeenCalledWith(
      // A linha inteira, sem a coluna do campo TX (A1).
      expect.stringMatching(/^prox-csv,\d+,ios,Pixel 9,CaioTo,-30,30\.0,30\.0,touched$/),
    );
    // Sem servidor: a calibração não chama nenhuma rota.
    expect(api.calls.filter((call) => call.key.includes('/proximity'))).toEqual([]);

    await userEvent.press(screen.getByRole('button', { name: 'Parar' }));
    await waitFor(() => {
      expect(radio.scanning).toBe(false);
    });
    expect(radio.advertising).toBeNull();
    expect(radio.keepScreenOn).toBe(false);
  });

  it('PROX-30: fora do build de desenvolvimento, a rota redireciona e o rádio não liga', async () => {
    jest.spyOn(devTools, 'isSimulationEnabled').mockReturnValue(false);
    const radio = createFakeRadio();
    await renderApp({ initialUrl: '/dev/proximidade', radio });
    await waitFor(() => {
      expect(screen.queryByTestId('tela-calibracao')).toBeNull();
    });
    expect(radio.scanning).toBe(false);
    expect(radio.advertising).toBeNull();
  });
});
