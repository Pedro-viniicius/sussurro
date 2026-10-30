import { userEvent } from '@testing-library/react-native';
import { useNetworkState } from 'expo-network';
import { act, screen, waitFor, within } from 'expo-router/testing-library';
import { Alert, type AlertButton } from 'react-native';

import { PROFILE_UPDATED_MESSAGE } from './EditarPerfilScreen';
import { SIGN_OUT_TITLE } from './PerfilScreen';
import { creatorMe, personalMe } from '../../test-utils/fake-api';
import { renderApp } from '../../test-utils/render-app';
import { DELETE_CONFIRM_TITLE, WRONG_PASSWORD_MESSAGE } from '../account/ExcluirContaScreen';
import { ACCOUNT_DELETED_MESSAGE, SESSION_EXPIRED_MESSAGE } from '../auth/AuthProvider';

/** Responde ao Alert apertando o botão destrutivo (confirmação). */
function confirmAlerts() {
  return jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons?: AlertButton[]) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('perfil próprio (história 1.5)', () => {
  it('CA1/CA6 (1.5): pessoal vê @, números, tipo, bio e a nota de privacidade', async () => {
    await renderApp({ signedInAs: personalMe(), initialUrl: '/pessoal/perfil' });
    expect(await screen.findByRole('header', { name: 'helena' })).toBeOnTheScreen();
    expect(screen.getByLabelText('5 publicações')).toBeOnTheScreen();
    expect(screen.getByLabelText('4 conexões')).toBeOnTheScreen();
    expect(screen.getByLabelText('3 criadores')).toBeOnTheScreen();
    expect(screen.getByText('Conta pessoal')).toBeOnTheScreen();
    expect(screen.getByText(/Só os números são públicos/)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Conectar ao vivo' })).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Compartilhe sua primeira foto' })).toBeOnTheScreen();
  });

  it('p19: criador vê publicações e seguidores e "Nova publicação"', async () => {
    await renderApp({ signedInAs: creatorMe() });
    expect(await screen.findByLabelText('2.418 seguidores')).toBeOnTheScreen();
    expect(screen.getByText('Criador de conteúdo · não segue ninguém')).toBeOnTheScreen();
    expect(screen.queryByText(/Só os números são públicos/)).not.toBeOnTheScreen();
    expect(
      within(screen.getByTestId('profile-header')).getByRole('button', { name: 'Nova publicação' }),
    ).toBeOnTheScreen();
  });

  it('X.3: e-mail não confirmado mostra o aviso e reenvia o link', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe({ emailVerified: false }),
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        fake.on('POST /v1/me/email/verification', { status: 202 });
      },
    });
    expect(await screen.findByTestId('email-verification-notice')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Reenviar link' }));
    await waitFor(() => {
      expect(api.callsTo('POST /v1/me/email/verification')).toHaveLength(1);
    });
  });

  it('CA4 (1.4): o ícone Sair pede confirmação ("Sair da conta?") e volta para Entrar', async () => {
    const alert = confirmAlerts();
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        fake.on('POST /v1/auth/logout', { status: 204 });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Sair da conta' }));
    expect(alert).toHaveBeenCalledWith(SIGN_OUT_TITLE, undefined, expect.any(Array));
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    expect(api.callsTo('POST /v1/auth/logout')).toHaveLength(1);
  });
});

/** Abre Editar perfil a partir do perfil, como no app (o modal fica sobre a aba). */
async function openEditProfile() {
  await userEvent.press(await screen.findByRole('button', { name: 'Editar perfil' }));
  await waitFor(() => {
    expect(screen).toHavePathname('/editar-perfil');
  });
}

describe('editar perfil (história 1.6)', () => {
  it('CA4 (1.6): @ e tipo só leitura; "Concluir" desabilitado sem mudanças; salvar atualiza', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        fake.on('PATCH /v1/me', ({ body }) => ({
          status: 200,
          body: { ...personalMe(), ...(body as object) },
        }));
      },
    });
    await openEditProfile();
    const done = await screen.findByRole('button', { name: 'Concluir' });
    expect(done).toBeDisabled();
    expect(screen.getByTestId('editar-handle').props.editable).toBe(false);
    expect(screen.getByTestId('editar-tipo').props.editable).toBe(false);
    expect(screen.getByText('Não dá para mudar na v1.')).toBeOnTheScreen();

    await userEvent.clear(screen.getByTestId('editar-nome'));
    await userEvent.type(screen.getByTestId('editar-nome'), 'Helena S.');
    expect(screen.getByRole('button', { name: 'Concluir' })).toBeEnabled();
    await userEvent.press(screen.getByRole('button', { name: 'Concluir' }));
    await waitFor(() => {
      expect(api.callsTo('PATCH /v1/me')).toHaveLength(1);
    });
    expect(api.callsTo('PATCH /v1/me')[0]?.body).toMatchObject({ name: 'Helena S.' });
    expect(await screen.findByText(PROFILE_UPDATED_MESSAGE)).toBeOnTheScreen();
  });

  it('[TXT-04] bio acima de 150 code points não é enviada', async () => {
    const { api } = await renderApp({ signedInAs: personalMe(), initialUrl: '/pessoal/perfil' });
    await openEditProfile();
    const bio = await screen.findByTestId('editar-bio');
    await userEvent.clear(bio);
    await userEvent.paste(bio, '😀'.repeat(151));
    expect(screen.getByText('151/150')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Concluir' }));
    expect(screen.getByText('Use no máximo 150 caracteres.')).toBeOnTheScreen();
    expect(api.callsTo('PATCH /v1/me')).toHaveLength(0);
  });
});

describe('conta e exclusão (histórias 1.4 e 1.7)', () => {
  it('CA2 (1.7): senha errada → "Senha incorreta." e a conta continua', async () => {
    confirmAlerts();
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/conta/excluir',
      configure: (fake) => {
        fake.on('DELETE /v1/me', {
          status: 401,
          body: { code: 'INVALID_CREDENTIALS', message: 'Senha incorreta' },
        });
      },
    });
    const button = await screen.findByRole('button', { name: 'Excluir minha conta' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Senha'), 'errada-123');
    await userEvent.press(screen.getByRole('button', { name: 'Excluir minha conta' }));
    expect(await screen.findByText(WRONG_PASSWORD_MESSAGE)).toBeOnTheScreen();
    expect(screen).toHavePathname('/conta/excluir');
  });

  it('CA1 (1.7): com a senha certa e a confirmação final, volta para Entrar com "Sua conta foi excluída."', async () => {
    const alert = confirmAlerts();
    const { api, store } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/conta/excluir',
      configure: (fake) => {
        fake.on('DELETE /v1/me', { status: 204 });
      },
    });
    await userEvent.type(await screen.findByLabelText('Senha'), 'cafe-coado-42');
    await userEvent.press(screen.getByRole('button', { name: 'Excluir minha conta' }));
    expect(alert).toHaveBeenCalledWith(
      DELETE_CONFIRM_TITLE,
      'Não dá para desfazer.',
      expect.any(Array),
    );
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    expect(screen.getByText(ACCOUNT_DELETED_MESSAGE)).toBeOnTheScreen();
    expect(api.callsTo('DELETE /v1/me')[0]?.body).toEqual({ password: 'cafe-coado-42' });
    await expect(store.getRefreshToken()).resolves.toBeNull();
  });

  it('CA2 (1.4): "Sair de todos os dispositivos" chama logout-all e volta para Entrar', async () => {
    confirmAlerts();
    const { api } = await renderApp({
      signedInAs: creatorMe(),
      initialUrl: '/conta',
      configure: (fake) => {
        fake.on('POST /v1/auth/logout-all', { status: 204 });
      },
    });
    expect(await screen.findByText('bia@example.com')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Sair de todos os dispositivos' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    expect(api.callsTo('POST /v1/auth/logout-all')).toHaveLength(1);
  });
});

describe('sessão e estados globais (ux.md §5.4)', () => {
  it('[AUTH-10] CA6 (1.3): refresh recusado → Entrar com "Sua sessão expirou." e o e-mail preenchido', async () => {
    const { api, client, store } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
    });
    await screen.findByRole('header', { name: 'helena' });
    await store.setLastEmail('helena@example.com');
    api.on('GET /v1/me', { status: 401, body: { code: 'UNAUTHORIZED', message: 'x' } });
    api.on('POST /v1/auth/refresh', { status: 401, body: { code: 'UNAUTHORIZED', message: 'x' } });

    await act(async () => {
      await client
        .request('/v1/me', { schema: { parse: (value: unknown) => value } })
        .catch(() => undefined);
    });
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    expect(screen.getByText(SESSION_EXPIRED_MESSAGE)).toBeOnTheScreen();
  });

  it('[AUTH-13] o app reabre logado a partir do refresh guardado (sem pedir senha)', async () => {
    const { api } = await renderApp({ signedInAs: personalMe() });
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio');
    });
    expect(api.callsTo('POST /v1/auth/refresh')[0]?.body).toEqual({ refreshToken: 'r0' });
  });

  it('sem internet na abertura com sessão guardada → tela de "Não foi possível conectar"', async () => {
    await renderApp({
      configure: (fake) => {
        fake.on('POST /v1/auth/refresh', () => {
          throw new TypeError('Network request failed');
        });
      },
      signedInAs: personalMe(),
    });
    expect(
      await screen.findByRole('header', { name: 'Não foi possível conectar' }),
    ).toBeOnTheScreen();
  });

  it('offline: a faixa "Sem internet" aparece depois de 2 s sem rede', async () => {
    jest.useFakeTimers();
    try {
      jest
        .mocked(useNetworkState)
        .mockReturnValue({ isConnected: false, isInternetReachable: false });
      await renderApp({ initialUrl: '/entrar' });
      expect(screen.queryByText('Sem internet')).not.toBeOnTheScreen();
      await act(async () => {
        await jest.advanceTimersByTimeAsync(2_000);
      });
      expect(screen.getByText('Sem internet')).toBeOnTheScreen();
    } finally {
      jest
        .mocked(useNetworkState)
        .mockReturnValue({ isConnected: true, isInternetReachable: true });
      jest.useRealTimers();
    }
  });
});
