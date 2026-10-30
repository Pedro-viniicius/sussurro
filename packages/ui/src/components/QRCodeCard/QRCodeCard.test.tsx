import { screen } from '@testing-library/react-native';

import { QRCodeCard, qrMatrix } from './QRCodeCard';
import { renderUi } from '../../test-utils/render';

const FIRST = 'sussurro://c/AbCdEfGhIjKlMn-_';
const SECOND = 'sussurro://c/ZyXwVuTsRqPoNm01';

describe('QRCodeCard (ux.md §4.10 e §6.14)', () => {
  it('a matriz do QR muda com o conteúdo e tem tamanho de QR (21 + 4n módulos)', () => {
    const first = qrMatrix(FIRST);
    const second = qrMatrix(SECOND);
    expect((first.modules - 21) % 4).toBe(0);
    expect(first.path).toMatch(/^M\d+ \d+h\d+v1h-\d+z/);
    expect(second.path).not.toBe(first.path);
  });

  it('4.7 CA1: mostra o QR com o avatar e o @; sem token ainda, carregando', async () => {
    const { rerender } = await renderUi(<QRCodeCard value={null} handle="helena" name="Helena" />);
    expect(screen.getByTestId('qr-card-carregando')).toBeOnTheScreen();
    expect(screen.getByText('helena')).toBeOnTheScreen();
    expect(screen.getByRole('image', { name: 'Seu código para conectar, @helena' })).toBeTruthy();

    await rerender(<QRCodeCard value={FIRST} handle="helena" name="Helena" />);
    expect(screen.queryByTestId('qr-card-carregando')).not.toBeOnTheScreen();
    expect(screen.getByTestId('qr-card-qr')).toBeTruthy();
  });

  it('4.2 CA3: token renovado troca o QR sem quadro vazio (o anterior some por cima)', async () => {
    const { rerender } = await renderUi(<QRCodeCard value={FIRST} handle="helena" />);
    await rerender(<QRCodeCard value={SECOND} handle="helena" />);
    // Nunca volta para "carregando" na troca.
    expect(screen.queryByTestId('qr-card-carregando')).not.toBeOnTheScreen();
    expect(screen.getByTestId('qr-card-qr')).toBeTruthy();
  });
});
