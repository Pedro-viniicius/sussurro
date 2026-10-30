import { render, screen, userEvent, within } from '@testing-library/react-native';

import { CatalogScreen } from './CatalogScreen';

jest.mock('expo-router', () => ({
  router: { canGoBack: () => false, back: jest.fn(), replace: jest.fn() },
}));

describe('CatalogScreen', () => {
  it('CA9 (0.8): smoke: o catálogo inteiro renderiza sem erro, com as quatro seções', async () => {
    await render(<CatalogScreen />);
    for (const title of ['Fundamentos', 'Marca', 'Ícones', 'Componentes']) {
      expect(screen.getAllByRole('header', { name: title }).length).toBeGreaterThan(0);
    }
  });

  it('CA9 (0.8): os 11 componentes base aparecem com variantes e estados', async () => {
    await render(<CatalogScreen />);
    const components = within(screen.getByTestId('catalog-section-componentes'));
    for (const block of [
      'Avatar',
      'Button',
      'Input',
      'TopTabs',
      'BottomTabBar',
      'Toast',
      'EmptyState',
      'CaughtUp',
      'StatsRow',
    ]) {
      expect(components.getByRole('header', { name: block })).toBeOnTheScreen();
    }
    // Logo e Icon têm seções próprias.
    expect(screen.getByTestId('lockup-blue')).toBeOnTheScreen();
    expect(
      screen.getAllByTestId('icon-house-fill', { includeHiddenElements: true }).length,
    ).toBeGreaterThan(0);
    // Estados do Button.
    expect(screen.getAllByRole('button', { name: 'Desabilitado' })[0]).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Carregando' })[0]).toBeBusy();
    // Estados do Input e do CaughtUp.
    expect(screen.getByText('Digite um e-mail válido.')).toBeOnTheScreen();
    expect(screen.getByText(/do último dia/)).toBeOnTheScreen();
    expect(screen.getByText(/das últimas 36 horas/)).toBeOnTheScreen();
    // Mensagem de erro vinda do contrato de packages/shared.
    expect(screen.getByText('Algo deu errado do nosso lado. Tente de novo.')).toBeOnTheScreen();
  });

  it('cores mostram o contraste calculado (ux.md §7.1)', async () => {
    await render(<CatalogScreen />);
    expect(screen.getByText(/#737373 · 4\.74:1 sobre white/)).toBeOnTheScreen();
  });

  it('CA11 (0.8): o controle de escala de fonte aumenta o texto', async () => {
    await render(<CatalogScreen />);
    const sample = () => screen.getAllByText('Domingo de manhã no Passaúna')[0];
    expect(sample()).toHaveStyle({ fontSize: 20 });
    await userEvent.press(screen.getByRole('button', { name: 'Escala de fonte 2,0' }));
    expect(sample()).toHaveStyle({ fontSize: 40 });
    expect(screen.getByRole('button', { name: 'Escala de fonte 2,0' })).toBeSelected();
  });

  it('as abas e a barra inferior do catálogo são interativas', async () => {
    await render(<CatalogScreen />);
    const feedTabs = within(screen.getByTestId('tabs-feed'));
    await userEvent.press(feedTabs.getByRole('tab', { name: 'Reels' }));
    expect(feedTabs.getByRole('tab', { name: 'Reels' })).toBeSelected();
    const personal = within(screen.getByTestId('tabbar-personal'));
    await userEvent.press(personal.getByRole('tab', { name: 'Conectar' }));
    expect(personal.getByRole('tab', { name: 'Conectar' })).toBeSelected();
  });

  it('"Mostrar Toast" usa o ToastProvider', async () => {
    await render(<CatalogScreen />);
    await userEvent.press(screen.getByRole('button', { name: 'Mostrar Toast' }));
    expect(
      screen.getByText('Muitas tentativas. Espere um pouco e tente de novo.'),
    ).toBeOnTheScreen();
  });

  it('2.10 CA1: componentes da Fase 2 no catálogo, com variantes e estados', async () => {
    await render(<CatalogScreen />);
    const phase2 = within(screen.getByTestId('catalog-section-fase2'));
    for (const block of [
      'PostPhoto',
      'PostText',
      'CommentsSheet',
      'ModePill',
      'MediaPickerGrid',
      'UploadBanner',
      'PhotoTile',
      'ProfileHeader (outra conta)',
      'Skeleton',
      'IconButton',
    ]) {
      expect(phase2.getByRole('header', { name: block })).toBeOnTheScreen();
    }
    // Carrossel 1/3, "N curtidas", "Ver todos os N comentários" e tempo relativo.
    const photo = within(screen.getByTestId('catalog-post-photo'));
    expect(photo.getByTestId('catalog-post-photo-counter')).toHaveTextContent('1/3');
    expect(photo.getByText('6 curtidas')).toBeOnTheScreen();
    expect(photo.getByText('Ver todos os 2 comentários')).toBeOnTheScreen();
    expect(photo.getByText('Há 18 minutos')).toBeOnTheScreen();
    await userEvent.press(photo.getByRole('button', { name: 'Curtir' }));
    expect(photo.getByText('7 curtidas')).toBeOnTheScreen();
    expect(phase2.getByText('1 curtida')).toBeOnTheScreen();
    expect(phase2.getByText('Ontem')).toBeOnTheScreen();
    // Thread de textos, estados dos comentários e do upload.
    expect(within(screen.getByTestId('catalog-post-text-0')).getByText('40 min')).toBeOnTheScreen();
    expect(phase2.getAllByText('Não publicado.').length).toBeGreaterThan(0);
    expect(phase2.getByText('Publicando… 2 de 3')).toBeOnTheScreen();
    expect(phase2.getByText('Não foi possível publicar.')).toBeOnTheScreen();
    expect(phase2.getByRole('tab', { name: 'Reel' })).toBeEnabled();
    expect(phase2.getByText('Processando')).toBeOnTheScreen();
  });

  it('Fase 3: SearchBar, UserRow, p17 com Seguir, menu ⋯ e os motivos da denúncia', async () => {
    await render(<CatalogScreen />);
    const phase3 = within(screen.getByTestId('catalog-section-fase3'));
    for (const block of [
      'SearchBar',
      'UserRow',
      'ProfileHeader (criador visto por pessoa, p17)',
      'ActionSheet',
      'Motivos da denúncia',
    ]) {
      expect(phase3.getByRole('header', { name: block })).toBeOnTheScreen();
    }
    await userEvent.press(phase3.getByRole('button', { name: 'Seguir @estudioaurora' }));
    expect(
      phase3.getByRole('button', { name: 'Seguindo @estudioaurora, toque para deixar de seguir' }),
    ).toBeOnTheScreen();
    expect(phase3.getAllByRole('radio')).toHaveLength(8);
    await userEvent.press(phase3.getByRole('button', { name: 'Abrir menu ⋯' }));
    expect(screen.getByRole('button', { name: 'Denunciar' })).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Cancelar' }));
  });

  it('Fase 4: seletor "Bluetooth / QR code", radar, par de avatares, QR e o perfil de conexão', async () => {
    await render(<CatalogScreen />);
    const phase4 = within(screen.getByTestId('catalog-section-fase4'));
    for (const block of [
      'SegmentedControl',
      'Radar',
      'PairAvatars',
      'QRCodeCard',
      'ProfileHeader (conexão)',
    ]) {
      expect(phase4.getByRole('header', { name: block })).toBeOnTheScreen();
    }
    await userEvent.press(phase4.getByRole('radio', { name: 'QR code' }));
    expect(phase4.getByRole('radio', { name: 'QR code' })).toBeChecked();
    expect(phase4.getByRole('button', { name: 'Procurar por perto' })).toBeOnTheScreen();
    expect(
      phase4.getByRole('button', { name: 'Conectados com @caio.r, toque para ver as opções' }),
    ).toBeOnTheScreen();
  });

  it('telas compostas do feed para comparar com p06 e p07', async () => {
    await render(<CatalogScreen />);
    const screens = within(screen.getByTestId('catalog-section-telas'));
    expect(screens.getByRole('header', { name: 'Feed Fotos (p06)' })).toBeOnTheScreen();
    expect(screens.getByRole('header', { name: 'Feed Textos (p07)' })).toBeOnTheScreen();
    expect(screens.getAllByText('Você está em dia')).toHaveLength(3);
    expect(screens.getByText(/todos os textos dos últimos 3 dias/)).toBeOnTheScreen();
  });

  it('Fase 5 (5.4): ReelTile nos três estados, faixa do reel e o feed Reels para comparar com p08', async () => {
    await render(<CatalogScreen />);
    const phase5 = within(screen.getByTestId('catalog-section-fase5'));
    expect(
      phase5.getByRole('button', { name: 'Reel de @cozinhadabia, 55 segundos' }),
    ).toBeOnTheScreen();
    expect(phase5.getByText('0:55')).toBeOnTheScreen();
    expect(phase5.getByText('Processando')).toBeOnTheScreen();
    expect(phase5.getByText('Falhou')).toBeOnTheScreen();
    expect(phase5.getByText('Processando o reel…')).toBeOnTheScreen();
    expect(phase5.getByText('O vídeo não está mais no aparelho.')).toBeOnTheScreen();
    const screens = within(screen.getByTestId('catalog-section-telas'));
    expect(screens.getByRole('header', { name: 'Feed Reels (p08)' })).toBeOnTheScreen();
    const grid = within(screens.getByTestId('catalog-feed-reels'));
    for (const duration of ['0:42', '0:18', '0:55', '0:12']) {
      expect(grid.getByText(duration)).toBeOnTheScreen();
    }
    expect(screens.getByText(/todos os reels dos últimos 3 dias/)).toBeOnTheScreen();
  });

  it('Fase 6: NotificationRow, o coração com o ponto e as telas p09 e p21', async () => {
    await render(<CatalogScreen />);
    const phase6 = within(screen.getByTestId('catalog-section-fase6'));
    expect(phase6.getByRole('header', { name: 'NotificationRow' })).toBeOnTheScreen();
    expect(phase6.getByTestId('catalog-coracao-dot')).toBeOnTheScreen();
    expect(phase6.getByText('2 novas pessoas começaram a seguir você.')).toBeOnTheScreen();
    const p09 = within(screen.getByTestId('catalog-notificacoes-p09'));
    expect(p09.getByText('“Que luz bonita!”')).toBeOnTheScreen();
    expect(p09.getByText('Isso é tudo por enquanto.')).toBeOnTheScreen();
    const p21 = within(screen.getByTestId('catalog-notificacoes-p21'));
    expect(p21.getByText('5 novas pessoas começaram a seguir você.')).toBeOnTheScreen();
    expect(p21.getByText(' comentou no seu reel: ')).toBeOnTheScreen();
    // Sem DSN nos testes: o erro de teste não sai.
    await userEvent.press(phase6.getByRole('button', { name: 'Enviar erro de teste' }));
    expect(await screen.findByText('O Sentry está desligado (sem DSN).')).toBeOnTheScreen();
  });
});
