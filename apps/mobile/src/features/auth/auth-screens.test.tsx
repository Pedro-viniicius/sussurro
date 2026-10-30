import { userEvent } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import { ACCOUNT_TYPE_WARNING, REGISTER_RATE_LIMIT_MESSAGE } from './CadastroScreen';
import { INVALID_LOGIN_MESSAGE, LOGIN_RATE_LIMIT_MESSAGE } from './EntrarScreen';
import { FORGOT_PASSWORD_SENT } from './EsqueciSenhaScreen';
import { PASSWORD_CHANGED_MESSAGE } from './RedefinirSenhaScreen';
import { creatorMe, personalMe, session } from '../../test-utils/fake-api';
import { renderApp, type RenderAppOptions } from '../../test-utils/render-app';

async function openSignIn(configure?: RenderAppOptions['configure']) {
  const result = await renderApp({ initialUrl: '/entrar', ...(configure ? { configure } : {}) });
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeOnTheScreen();
  });
  return result;
}

describe('Entrar (história 1.2)', () => {
  it('CA6 (1.2): o campo diz "E-mail"; não existe a entrada de demonstração nem o "OU"', async () => {
    await openSignIn();
    expect(screen.getByLabelText('E-mail')).toBeOnTheScreen();
    expect(screen.queryByText(/nome de usuário/)).not.toBeOnTheScreen();
    expect(screen.queryByText(/demo/i)).not.toBeOnTheScreen();
    expect(screen.queryByText('OU')).not.toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Esqueceu a senha?' })).toBeOnTheScreen();
  });

  it('CA1 (1.2): credenciais certas → entra na navegação do tipo de conta', async () => {
    const { api } = await openSignIn((fake) => {
      fake.on('POST /v1/auth/login', { status: 200, body: session(creatorMe()) });
    });
    await userEvent.type(screen.getByLabelText('E-mail'), 'bia@example.com');
    await userEvent.type(screen.getByLabelText('Senha'), 'cafe-coado-42');
    await userEvent.press(screen.getByRole('button', { name: 'Entrar' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/criador/perfil');
    });
    expect(api.callsTo('POST /v1/auth/login')[0]?.body).toMatchObject({
      email: 'bia@example.com',
      password: 'cafe-coado-42',
    });
  });

  it('[AUTH-14] CA2 (1.2): 401 → "E-mail ou senha incorretos." (nunca o código técnico)', async () => {
    await openSignIn((fake) => {
      fake.on('POST /v1/auth/login', {
        status: 401,
        body: { code: 'INVALID_CREDENTIALS', message: 'E-mail ou senha incorretos.' },
      });
    });
    await userEvent.type(screen.getByLabelText('E-mail'), 'ana@example.com');
    await userEvent.type(screen.getByLabelText('Senha'), 'errada-123');
    await userEvent.press(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByText(INVALID_LOGIN_MESSAGE)).toBeOnTheScreen();
    expect(screen.queryByText('INVALID_CREDENTIALS')).not.toBeOnTheScreen();
  });

  it('CA3 (1.2): 429 → "Muitas tentativas. Tente de novo em 1 minuto."', async () => {
    await openSignIn((fake) => {
      fake.on('POST /v1/auth/login', {
        status: 429,
        body: { code: 'RATE_LIMITED', message: 'limite' },
      });
    });
    await userEvent.type(screen.getByLabelText('E-mail'), 'ana@example.com');
    await userEvent.type(screen.getByLabelText('Senha'), 'qualquer-1');
    await userEvent.press(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByText(LOGIN_RATE_LIMIT_MESSAGE)).toBeOnTheScreen();
  });

  it('campos vazios mostram o erro sem chamar a API', async () => {
    const { api } = await openSignIn();
    await userEvent.press(screen.getByRole('button', { name: 'Entrar' }));
    expect(screen.getByText('Digite seu e-mail.')).toBeOnTheScreen();
    expect(screen.getByText('Digite sua senha.')).toBeOnTheScreen();
    expect(api.calls).toHaveLength(0);
  });
});

describe('Cadastro (história 1.1)', () => {
  async function openSignUp(configure?: RenderAppOptions['configure']) {
    const result = await renderApp({
      initialUrl: '/cadastro',
      ...(configure ? { configure } : {}),
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cadastrar-se' })).toBeOnTheScreen();
    });
    return result;
  }

  async function fill(handle = 'Ana.Lima') {
    await userEvent.type(screen.getByLabelText('E-mail'), 'ana@example.com');
    await userEvent.type(screen.getByLabelText('Nome completo'), 'Ana Lima');
    await userEvent.type(screen.getByLabelText('Nome de usuário'), handle);
    await userEvent.type(screen.getByLabelText('Senha'), 'cafe-coado-42');
  }

  it('CA8 (1.1): Pessoal vem marcado; ao escolher Criador aparece o aviso do tipo definitivo', async () => {
    await openSignUp();
    expect(screen.getByRole('radio', { name: 'Pessoal' })).toBeChecked();
    expect(screen.queryByText(ACCOUNT_TYPE_WARNING)).not.toBeOnTheScreen();
    await userEvent.press(screen.getByRole('radio', { name: 'Criador' }));
    expect(screen.getByRole('radio', { name: 'Criador' })).toBeChecked();
    expect(screen.getByText(ACCOUNT_TYPE_WARNING)).toBeOnTheScreen();
    expect(screen.getByText('Tem uma conta?')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Entre' })).toBeOnTheScreen();
  });

  it('CA8 (1.1): o @ vira minúsculas ao digitar; o cadastro vai com o tipo escolhido', async () => {
    const { api } = await openSignUp((fake) => {
      fake.on('POST /v1/auth/register', {
        status: 201,
        body: session(creatorMe({ handle: 'ana.lima' })),
      });
    });
    await fill();
    expect(screen.getByLabelText('Nome de usuário').props.value).toBe('ana.lima');
    await userEvent.press(screen.getByRole('radio', { name: 'Criador' }));
    await userEvent.press(screen.getByRole('button', { name: 'Cadastrar-se' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/criador/perfil');
    });
    expect(api.callsTo('POST /v1/auth/register')[0]?.body).toMatchObject({
      email: 'ana@example.com',
      handle: 'ana.lima',
      accountType: 'creator',
    });
  });

  it('CA3 (1.1): e-mail em uso aparece no campo', async () => {
    await openSignUp((fake) => {
      fake.on('POST /v1/auth/register', {
        status: 409,
        body: { code: 'EMAIL_TAKEN', message: 'E-mail em uso' },
      });
    });
    await fill();
    await userEvent.press(screen.getByRole('button', { name: 'Cadastrar-se' }));
    expect(await screen.findByText('Este e-mail já está em uso.')).toBeOnTheScreen();
  });

  it('CA7 (1.1): 429 → "Muitos cadastros desta rede. Tente mais tarde."', async () => {
    await openSignUp((fake) => {
      fake.on('POST /v1/auth/register', {
        status: 429,
        body: { code: 'RATE_LIMITED', message: 'limite' },
      });
    });
    await fill();
    await userEvent.press(screen.getByRole('button', { name: 'Cadastrar-se' }));
    expect(await screen.findByText(REGISTER_RATE_LIMIT_MESSAGE)).toBeOnTheScreen();
  });

  it('valida no app com as regras de packages/shared (senha fraca, @ reservado) sem chamar a API', async () => {
    const { api } = await openSignUp();
    await userEvent.type(screen.getByLabelText('E-mail'), 'ana@');
    await userEvent.type(screen.getByLabelText('Nome de usuário'), 'admin');
    await userEvent.type(screen.getByLabelText('Senha'), 'senha123');
    await userEvent.press(screen.getByRole('button', { name: 'Cadastrar-se' }));
    expect(screen.getByText('Digite um e-mail válido.')).toBeOnTheScreen();
    expect(screen.getByText('Este nome de usuário não está disponível.')).toBeOnTheScreen();
    expect(
      screen.getByText('Use pelo menos 8 caracteres e evite senhas comuns.'),
    ).toBeOnTheScreen();
    expect(api.calls).toHaveLength(0);
  });
});

describe('Esqueci a senha, redefinir e verificar e-mail (D6)', () => {
  it('1.10: pedir o link mostra a mesma mensagem, exista o e-mail ou não', async () => {
    const { api } = await renderApp({
      initialUrl: '/esqueci-senha',
      configure: (fake) => {
        fake.on('POST /v1/auth/password/forgot', { status: 202 });
      },
    });
    await userEvent.type(await screen.findByLabelText('E-mail'), 'ana@example.com');
    await userEvent.press(screen.getByRole('button', { name: 'Enviar link' }));
    expect(await screen.findByText(FORGOT_PASSWORD_SENT)).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/auth/password/forgot')[0]?.body).toEqual({
      email: 'ana@example.com',
    });
  });

  it('1.10: o link do e-mail abre a troca de senha; senha fraca é recusada no app; depois volta para Entrar', async () => {
    const { api } = await renderApp({
      initialUrl: '/redefinir-senha?token=abc',
      configure: (fake) => {
        fake.on('POST /v1/auth/password/reset', { status: 204 });
      },
    });
    const input = await screen.findByLabelText('Nova senha');
    await userEvent.type(input, 'senha123');
    await userEvent.press(screen.getByRole('button', { name: 'Salvar senha' }));
    expect(
      screen.getByText('Use pelo menos 8 caracteres e evite senhas comuns.'),
    ).toBeOnTheScreen();

    await userEvent.clear(input);
    await userEvent.type(input, 'nova-senha-forte-1');
    await userEvent.press(screen.getByRole('button', { name: 'Salvar senha' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    expect(screen.getByText(PASSWORD_CHANGED_MESSAGE)).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/auth/password/reset')[0]?.body).toEqual({
      token: 'abc',
      password: 'nova-senha-forte-1',
    });
  });

  it('1.10: link vencido → "Link inválido" com a opção de pedir outro', async () => {
    await renderApp({
      initialUrl: '/redefinir-senha?token=velho',
      configure: (fake) => {
        fake.on('POST /v1/auth/password/reset', {
          status: 400,
          body: { code: 'INVALID_TOKEN', message: 'vencido' },
        });
      },
    });
    await userEvent.type(await screen.findByLabelText('Nova senha'), 'nova-senha-forte-1');
    await userEvent.press(screen.getByRole('button', { name: 'Salvar senha' }));
    expect(await screen.findByRole('header', { name: 'Link inválido' })).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Pedir um novo link' })).toBeOnTheScreen();
  });

  it('X.3: o link de confirmação confirma o e-mail', async () => {
    const { api } = await renderApp({
      initialUrl: '/verificar-email?token=xyz',
      signedInAs: personalMe({ emailVerified: false }),
      configure: (fake) => {
        fake.on('POST /v1/auth/email/verify', { status: 204 });
      },
    });
    expect(await screen.findByRole('header', { name: 'E-mail confirmado' })).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/auth/email/verify')[0]?.body).toEqual({ token: 'xyz' });
  });

  it('X.3: link reutilizado → "Link inválido"', async () => {
    await renderApp({
      initialUrl: '/verificar-email?token=usado',
      configure: (fake) => {
        fake.on('POST /v1/auth/email/verify', {
          status: 400,
          body: { code: 'INVALID_TOKEN', message: 'usado' },
        });
      },
    });
    expect(await screen.findByRole('header', { name: 'Link inválido' })).toBeOnTheScreen();
  });
});
