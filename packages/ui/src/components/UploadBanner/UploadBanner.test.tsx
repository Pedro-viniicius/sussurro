import { screen, userEvent } from '@testing-library/react-native';

import { UploadBanner, uploadBannerText } from './UploadBanner';
import { renderUi } from '../../test-utils/render';

describe('UploadBanner (ux.md §5.3)', () => {
  it.each([
    ['uploading', 0, 3, 'Publicando… 1 de 3'],
    ['uploading', 1, 3, 'Publicando… 2 de 3'],
    ['uploading', 0, 1, 'Publicando…'],
    ['processing', 3, 3, 'Publicando…'],
    ['failed', 0, 3, 'Não foi possível publicar.'],
  ] as const)('%s %i/%i → "%s"', (status, done, total, expected) => {
    expect(uploadBannerText(status, done, total)).toBe(expected);
  });

  it('enviando: texto e barra determinada', async () => {
    await renderUi(<UploadBanner status="uploading" done={1} total={2} thumbUri="file:///a.jpg" />);
    expect(screen.getByText('Publicando… 2 de 2')).toBeOnTheScreen();
    expect(screen.getByTestId('upload-banner-progress-fill')).toHaveStyle({ width: '50%' });
  });

  it('falha: "Tentar de novo" e ✕ (descartar)', async () => {
    const onRetry = jest.fn();
    const onDiscard = jest.fn();
    await renderUi(<UploadBanner status="failed" onRetry={onRetry} onDiscard={onDiscard} />);
    expect(screen.getByText('Não foi possível publicar.')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    await userEvent.press(screen.getByRole('button', { name: 'Descartar publicação' }));
    expect(onRetry).toHaveBeenCalled();
    expect(onDiscard).toHaveBeenCalled();
    expect(screen.queryByTestId('upload-banner-progress')).not.toBeOnTheScreen();
  });

  it.each([
    ['uploading', 'Publicando…'],
    ['processing', 'Processando o reel…'],
    ['failed', 'Não foi possível publicar.'],
    ['unavailable', 'O vídeo não está mais no aparelho.'],
  ] as const)('5.3: reel %s → "%s"', (status, expected) => {
    expect(uploadBannerText(status, 0, 1, 'reel')).toBe(expected);
  });

  it('5.3: reel enviando usa a fração dos bytes; processando fica indeterminada', async () => {
    await renderUi(<UploadBanner kind="reel" status="uploading" progress={0.25} total={1} />);
    expect(screen.getByTestId('upload-banner-progress-fill')).toHaveStyle({ width: '25%' });
    await renderUi(<UploadBanner kind="reel" status="processing" total={1} />);
    expect(screen.getByText('Processando o reel…')).toBeOnTheScreen();
    expect(screen.queryByTestId('upload-banner-progress-fill')).not.toBeOnTheScreen();
  });

  it('5.6: vídeo indisponível oferece "Escolher o vídeo de novo" e ✕', async () => {
    const onRetry = jest.fn();
    const onDiscard = jest.fn();
    await renderUi(
      <UploadBanner kind="reel" status="unavailable" onRetry={onRetry} onDiscard={onDiscard} />,
    );
    expect(screen.getByText('O vídeo não está mais no aparelho.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).not.toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Escolher o vídeo de novo' }));
    expect(onRetry).toHaveBeenCalled();
    await userEvent.press(screen.getByRole('button', { name: 'Descartar publicação' }));
    expect(onDiscard).toHaveBeenCalled();
  });
});
