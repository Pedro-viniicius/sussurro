import { userEvent } from '@testing-library/react-native';
import { screen, waitFor, within } from 'expo-router/testing-library';

import { COPY } from '../features/connect/copy';
import { configureConnect } from '../test-utils/connect-fixtures';
import { creatorMe, personalMe } from '../test-utils/fake-api';
import { renderApp } from '../test-utils/render-app';

function tabNames(testID: string): string[] {
  const bar = within(screen.getByTestId(testID));
  return bar.getAllByRole('tab').map((tab) => String(tab.props.accessibilityLabel));
}

describe('navegação por tipo de conta (história 1.9)', () => {
  it('sem sessão, "/" vai para Entrar', async () => {
    await renderApp();
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    expect(screen.getByLabelText('E-mail')).toBeOnTheScreen();
  });

  it('CA1 (1.9): pessoal entra no Início com Início, Pesquisar, Criar, Conectar e Perfil, nessa ordem', async () => {
    await renderApp({ signedInAs: personalMe() });
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio');
    });
    expect(tabNames('tabbar-personal')).toEqual([
      'Início',
      'Pesquisar',
      'Criar publicação',
      'Conectar',
      'Perfil',
    ]);
    expect(screen.getByRole('tab', { name: 'Início' })).toBeSelected();
    expect(screen.getByTestId('tela-inicio')).toBeOnTheScreen();
  });

  it('CA2 (1.9): criador entra no Perfil e só tem Notificações, Criar e Perfil', async () => {
    await renderApp({ signedInAs: creatorMe() });
    await waitFor(() => {
      expect(screen).toHavePathname('/criador/perfil');
    });
    expect(tabNames('tabbar-creator')).toEqual(['Notificações', 'Criar publicação', 'Perfil']);
    for (const forbidden of ['Início', 'Pesquisar', 'Conectar']) {
      expect(screen.queryByRole('tab', { name: forbidden })).not.toBeOnTheScreen();
    }
    expect(screen.getByRole('header', { name: 'cozinhadabia' })).toBeOnTheScreen();
  });

  // O criador que abre /pessoal/conectar vê o p22 (4.8 CA2, em connect-qr.test.tsx).
  it.each(['/pessoal/inicio', '/pessoal/pesquisar'])(
    'CA2/CA4 (1.9): deep link do criador para %s volta para o Perfil dele',
    async (url) => {
      await renderApp({ signedInAs: creatorMe(), initialUrl: url });
      await waitFor(() => {
        expect(screen).toHavePathname('/criador/perfil');
      });
      expect(screen.queryByTestId('tela-conectar')).not.toBeOnTheScreen();
      expect(screen.queryByTestId('tela-inicio')).not.toBeOnTheScreen();
    },
  );

  it('CA4 (1.9): deep link da pessoa para a área do criador volta para o Início dela', async () => {
    await renderApp({ signedInAs: personalMe(), initialUrl: '/criador/notificacoes' });
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio');
    });
  });

  it('sem sessão, uma rota logada manda para Entrar', async () => {
    await renderApp({ initialUrl: '/pessoal/perfil' });
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
  });

  it('a aba Criar abre o modal de nova publicação (sem tab bar)', async () => {
    await renderApp({ signedInAs: personalMe() });
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio');
    });
    await userEvent.press(screen.getByRole('tab', { name: 'Criar publicação' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/criar');
    });
    expect(screen.getByRole('header', { name: 'Nova publicação' })).toBeOnTheScreen();
    expect(screen.getByTestId('criar-foto')).toBeOnTheScreen();
    expect(screen.queryByTestId('tabbar-personal')).not.toBeOnTheScreen();
  });

  it('a aba Conectar abre a tela de conexão presencial (Fase 4)', async () => {
    await renderApp({ signedInAs: personalMe(), configure: configureConnect });
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio');
    });
    await userEvent.press(screen.getByRole('tab', { name: 'Conectar' }));
    await waitFor(() => {
      expect(screen.getByTestId('tela-conectar')).toBeOnTheScreen();
    });
    expect(screen.getByRole('header', { name: COPY.title })).toBeOnTheScreen();
    expect(await screen.findByText(COPY.intro)).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Conectar' })).toBeSelected();
    await userEvent.press(screen.getByRole('tab', { name: 'Perfil' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/perfil');
    });
  });
});
