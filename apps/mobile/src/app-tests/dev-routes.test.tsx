import { screen, waitFor } from 'expo-router/testing-library';

import * as devRoutes from '../lib/dev-routes';
import { renderApp } from '../test-utils/render-app';

describe('rotas /dev (D15)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('em dev, /dev/catalog abre o catálogo', async () => {
    jest.spyOn(devRoutes, 'isDevRoutesEnabled').mockReturnValue(true);
    await renderApp({ initialUrl: '/dev/catalog' });
    expect(screen).toHavePathname('/dev/catalog');
    expect(screen.getByRole('header', { name: 'Catálogo' })).toBeOnTheScreen();
  });

  it('CA10 (0.8): fora de dev, /dev/catalog redireciona (e acaba em Entrar sem sessão)', async () => {
    jest.spyOn(devRoutes, 'isDevRoutesEnabled').mockReturnValue(false);
    await renderApp({ initialUrl: '/dev/catalog' });
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    expect(screen.queryByRole('header', { name: 'Catálogo' })).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Catálogo de componentes (dev)' })).toBeNull();
  });

  it('CA2 (0.7): Entrar mostra o lockup e a tagline; em dev, oferece o catálogo', async () => {
    jest.spyOn(devRoutes, 'isDevRoutesEnabled').mockReturnValue(true);
    await renderApp();
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    expect(screen.getByRole('header', { name: 'Sussurro' })).toBeOnTheScreen();
    expect(screen.getByText('A rede social sem algoritmo.')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Catálogo de componentes (dev)' })).toBeOnTheScreen();
  });
});
