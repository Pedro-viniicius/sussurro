import { REPORT_REASON_LABELS, REPORT_REASONS } from '@sussurro/shared';
import { userEvent } from '@testing-library/react-native';
import { screen, waitFor, within } from 'expo-router/testing-library';
import { AccessibilityInfo, Alert, type AlertButton } from 'react-native';

import {
  COMMENT_GONE_MESSAGE,
  REPORT_DETAILS_LABEL,
  REPORT_DETAILS_TOO_LONG,
  REPORT_PRIVACY_NOTE,
  REPORT_SENT_MESSAGE,
} from './ReportScreen';
import { BLOCK_MESSAGE, UNBLOCK_MESSAGE } from './useBlockAccount';
import { OFFLINE_MESSAGE } from '../../lib/error-messages';
import { creatorMe, personalMe } from '../../test-utils/fake-api';
import {
  AUTHORS,
  comment,
  feedPage,
  photoPost,
  textPost,
  thread,
} from '../../test-utils/post-fixtures';
import {
  blockedAccount,
  creatorProfile,
  NOT_FOUND,
  RATE_LIMITED,
} from '../../test-utils/relation-fixtures';
import { renderApp } from '../../test-utils/render-app';
import { OWN_LIST_NOTE } from '../lists/OwnListScreen';
import { PROFILE_GONE_MESSAGE } from '../relations/useFollowToggle';

afterEach(() => {
  jest.restoreAllMocks();
});

const COMMENT_ID = '01a189e0-af57-7000-8000-00000000abcd';

/** A data de "Contas bloqueadas", com o espaço não separável (U+00A0) entre o dia e o mês. */
const BLOCKED_AT_LABEL = 'Bloqueio em 27 out';

/** Responde ao Alert apertando o botão com este texto. */
function answerAlerts(...texts: string[]) {
  return jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons?: AlertButton[]) => {
      buttons
        ?.find((button) => button.text !== undefined && texts.includes(button.text))
        ?.onPress?.();
    });
}

/** Ações do menu ⋯ aberto, na ordem (com o "Cancelar"). */
function menuLabels(testID = 'moderation-menu'): string[] {
  return within(screen.getByTestId(testID))
    .getAllByRole('button')
    .map((node) => String(node.props.accessibilityLabel));
}

async function openPostMenu(postId: string) {
  await userEvent.press(
    within(await screen.findByTestId(`post-${postId}`)).getByRole('button', {
      name: 'Mais opções',
    }),
  );
}

describe('menu ⋯ (D-UX14)', () => {
  it('post de outra conta: "Denunciar" antes de "Bloquear"; o próprio post não tem esses itens', async () => {
    const other = photoPost();
    const own = textPost({ isOwn: true, author: AUTHORS.helena, text: 'Meu texto' });
    const alert = answerAlerts('Cancelar');
    await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', ({ query }) => ({
          status: 200,
          body: feedPage(query.type === 'photo' ? [other] : [own]),
        }));
      },
    });
    await openPostMenu(other.id);
    expect(screen.getByRole('header', { name: 'Publicação de @marinac' })).toBeOnTheScreen();
    expect(menuLabels()).toEqual(['Denunciar', 'Bloquear', 'Cancelar']);
    await userEvent.press(screen.getByRole('button', { name: 'Cancelar' }));

    await userEvent.press(screen.getByRole('tab', { name: 'Textos' }));
    await openPostMenu(own.id);
    // No próprio post o ⋯ vai direto para "Excluir publicação?" (2.9).
    expect(alert).toHaveBeenCalledWith('Excluir publicação?', 'Não dá para desfazer.', [
      expect.objectContaining({ text: 'Cancelar' }),
      expect.objectContaining({ text: 'Excluir' }),
    ]);
    expect(screen.queryByRole('button', { name: 'Denunciar' })).not.toBeOnTheScreen();
  });

  it('comentário próprio: a pressão longa não tem "Denunciar" nem "Bloquear"', async () => {
    const post = photoPost();
    const mine = thread({
      body: 'Meu comentário',
      author: { ...AUTHORS.helena, profileVisible: true },
      canDelete: true,
    });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: `/pessoal/inicio/p/${post.id}`,
      configure: (fake) => {
        fake.on(`GET /v1/posts/${post.id}`, { status: 200, body: post });
        fake.on(`GET /v1/posts/${post.id}/comments`, {
          status: 200,
          body: { items: [mine], nextCursor: null },
        });
      },
    });
    await userEvent.longPress(await screen.findByTestId(`comment-${mine.id}`));
    expect(menuLabels('comments-menu')).toEqual(['Responder', 'Excluir', 'Cancelar']);
  });
});

describe('Denunciar (X.1)', () => {
  it('X.1 CA1: publicação: os 8 motivos, motivo obrigatório, detalhes até 500 e o Toast neutro', async () => {
    const post = photoPost();
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', { status: 200, body: feedPage([post]) });
        fake.on('POST /v1/reports', { status: 202 });
      },
    });
    await openPostMenu(post.id);
    await userEvent.press(screen.getByRole('button', { name: 'Denunciar' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/denunciar');
    });
    expect(
      await screen.findByRole('header', {
        name: 'Por que você está denunciando esta publicação?',
      }),
    ).toBeOnTheScreen();
    const reasons = screen
      .getAllByRole('radio')
      .map((node) => String(node.props.accessibilityLabel));
    expect(reasons).toEqual(REPORT_REASONS.map((reason) => REPORT_REASON_LABELS[reason]));
    expect(screen.getByText(REPORT_PRIVACY_NOTE)).toBeOnTheScreen();

    // Sem motivo, "Enviar" fica desabilitado.
    const send = screen.getByRole('button', { name: 'Enviar' });
    expect(send).toBeDisabled();
    await userEvent.press(send);
    expect(api.callsTo('POST /v1/reports')).toHaveLength(0);

    await userEvent.press(screen.getByRole('radio', { name: 'Spam ou golpe' }));
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();

    // Acima de 500 caracteres: contador em vermelho, aviso e "Enviar" desabilitado.
    const details = screen.getByLabelText(REPORT_DETAILS_LABEL);
    await userEvent.paste(details, 'a'.repeat(501));
    expect(screen.getByText('501/500')).toBeOnTheScreen();
    expect(screen.getByText(REPORT_DETAILS_TOO_LONG)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();

    await userEvent.clear(details);
    await userEvent.paste(details, '  Link suspeito na legenda  ');
    await userEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => {
      expect(api.callsTo('POST /v1/reports')).toHaveLength(1);
    });
    expect(api.callsTo('POST /v1/reports')[0]?.body).toEqual({
      target: { type: 'post', id: post.id },
      reason: 'spam',
      details: 'Link suspeito na legenda',
    });
    expect(await screen.findByText(REPORT_SENT_MESSAGE)).toBeOnTheScreen();
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio');
    });
  });

  it('X.1: conta pelo ⋯ do perfil vai como alvo "account", sem detalhes', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/pesquisar/u/trilhasdosul',
      configure: (fake) => {
        fake.on('GET /v1/users/trilhasdosul', { status: 200, body: creatorProfile() });
        fake.on('GET /v1/users/trilhasdosul/posts', {
          status: 200,
          body: { items: [], nextCursor: null },
        });
        fake.on('POST /v1/reports', { status: 202 });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Mais opções' }));
    expect(screen.getByRole('header', { name: 'Perfil de @trilhasdosul' })).toBeOnTheScreen();
    expect(menuLabels()).toEqual(['Denunciar', 'Bloquear', 'Cancelar']);
    await userEvent.press(screen.getByRole('button', { name: 'Denunciar' }));
    expect(
      await screen.findByRole('header', { name: 'Por que você está denunciando @trilhasdosul?' }),
    ).toBeOnTheScreen();
    await userEvent.press(
      screen.getByRole('radio', { name: 'Perfil falso ou se passando por outra pessoa' }),
    );
    await userEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => {
      expect(api.callsTo('POST /v1/reports')[0]?.body).toEqual({
        target: { type: 'account', handle: 'trilhasdosul' },
        reason: 'impersonation',
      });
    });
    expect(await screen.findByText(REPORT_SENT_MESSAGE)).toBeOnTheScreen();
  });

  it('X.1: 429 mantém o formulário com o aviso para tentar de novo', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: `/denunciar?alvo=comentario&id=${COMMENT_ID}`,
      configure: (fake) => {
        fake.on('POST /v1/reports', RATE_LIMITED);
      },
    });
    expect(
      await screen.findByRole('header', {
        name: 'Por que você está denunciando este comentário?',
      }),
    ).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('radio', { name: 'Assédio ou bullying' }));
    await userEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(
      await screen.findByText('Muitas tentativas. Espere um pouco e tente de novo.'),
    ).toBeOnTheScreen();
    // ux.md §11.18: a rota é um modal nativo, e no iOS o Toast da raiz ficaria atrás dele. O erro
    // sai na linha do próprio formulário, anunciada uma vez.
    expect(screen.getByTestId('denunciar-erro')).toHaveTextContent(
      'Muitas tentativas. Espere um pouco e tente de novo.',
    );
    expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
      'Muitas tentativas. Espere um pouco e tente de novo.',
    );
    expect(screen).toHavePathname('/denunciar');
    expect(screen.getByRole('radio', { name: 'Assédio ou bullying' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
  });

  it('X.1: 404 (o comentário sumiu) fecha a denúncia com o aviso', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: `/denunciar?alvo=comentario&id=${COMMENT_ID}`,
      configure: (fake) => {
        fake.on('POST /v1/reports', NOT_FOUND);
      },
    });
    await userEvent.press(await screen.findByRole('radio', { name: 'Assédio ou bullying' }));
    await userEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText(COMMENT_GONE_MESSAGE)).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/reports')[0]?.body).toEqual({
      target: { type: 'comment', id: COMMENT_ID },
      reason: 'harassment',
    });
    await waitFor(() => {
      expect(screen).not.toHavePathname('/denunciar');
    });
  });
});

describe('Bloquear (X.2)', () => {
  it('X.2 CA1/CA3: pelo perfil, a confirmação explica o efeito; sai do perfil e os posts da conta somem do feed', async () => {
    const fromCreator = photoPost({ author: AUTHORS.cozinhadabia });
    const fromConnection = photoPost();
    const alert = answerAlerts('Bloquear');
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', {
          status: 200,
          body: feedPage([fromCreator, fromConnection]),
        });
        fake.on('GET /v1/users/cozinhadabia', {
          status: 200,
          body: creatorProfile({ handle: 'cozinhadabia', name: 'Beatriz Lemos' }),
        });
        fake.on('GET /v1/users/cozinhadabia/posts', {
          status: 200,
          body: { items: [fromCreator], nextCursor: null },
        });
        fake.on('POST /v1/me/blocks', { status: 204 });
      },
    });
    await userEvent.press(
      await screen.findByRole('button', { name: 'Abrir perfil de @cozinhadabia, Criador' }),
    );
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio/u/cozinhadabia');
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Mais opções' }));
    await userEvent.press(screen.getByRole('button', { name: 'Bloquear' }));
    await waitFor(() => {
      expect(alert).toHaveBeenCalledWith(
        'Bloquear @cozinhadabia?',
        BLOCK_MESSAGE,
        expect.any(Array),
      );
    });
    expect(BLOCK_MESSAGE).toMatch(/A conexão e os follows entre vocês são desfeitos/);
    expect(BLOCK_MESSAGE).toMatch(/comentários de um nas publicações do outro são apagados/);
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio');
    });
    expect(api.callsTo('POST /v1/me/blocks')[0]?.body).toEqual({ handle: 'cozinhadabia' });
    expect(await screen.findByText('Você bloqueou @cozinhadabia.')).toBeOnTheScreen();
    // Sem recarregar o feed: o post da conta bloqueada sumiu, o da conexão ficou.
    expect(screen.queryByTestId(`post-${fromCreator.id}`)).not.toBeOnTheScreen();
    expect(screen.getByTestId(`post-${fromConnection.id}`)).toBeOnTheScreen();
    expect(api.callsTo('GET /v1/feed')).toHaveLength(1);
  });

  it('X.2: pelo post no feed, "Cancelar" na confirmação não bloqueia', async () => {
    const post = photoPost();
    answerAlerts('Cancelar');
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', { status: 200, body: feedPage([post]) });
      },
    });
    await openPostMenu(post.id);
    await userEvent.press(screen.getByRole('button', { name: 'Bloquear' }));
    await waitFor(() => {
      expect(Alert.alert).toHaveBeenCalled();
    });
    expect(api.callsTo('POST /v1/me/blocks')).toHaveLength(0);
    expect(screen.getByTestId(`post-${post.id}`)).toBeOnTheScreen();
  });

  it('X.2: pelo comentário, bloqueia com o commentId e tira da lista carregada os comentários da conta', async () => {
    const post = photoPost({ author: AUTHORS.cozinhadabia });
    const first = thread({
      body: 'Que luz bonita!',
      replies: [
        comment({ body: 'Concordo!', author: { ...AUTHORS.marinac, profileVisible: false } }),
      ],
    });
    const second = thread({
      body: 'Comentário da Marina',
      author: { ...AUTHORS.marinac, profileVisible: false },
    });
    answerAlerts('Bloquear');
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: `/pessoal/inicio/p/${post.id}`,
      configure: (fake) => {
        fake.on(`GET /v1/posts/${post.id}`, { status: 200, body: post });
        fake.on(`GET /v1/posts/${post.id}/comments`, {
          status: 200,
          body: { items: [first, second], nextCursor: null },
        });
        fake.on('POST /v1/me/blocks', { status: 204 });
      },
    });
    await userEvent.longPress(await screen.findByTestId(`comment-${second.id}`));
    expect(menuLabels('comments-menu')).toEqual(['Responder', 'Denunciar', 'Bloquear', 'Cancelar']);
    await userEvent.press(screen.getByRole('button', { name: 'Bloquear' }));
    await waitFor(() => {
      expect(api.callsTo('POST /v1/me/blocks')[0]?.body).toEqual({ commentId: second.id });
    });
    await waitFor(() => {
      expect(screen.queryByText('Comentário da Marina')).not.toBeOnTheScreen();
    });
    expect(screen.queryByText('Concordo!')).not.toBeOnTheScreen();
    expect(screen.getByText('Que luz bonita!')).toBeOnTheScreen();
  });

  it('X.1: "Denunciar" na pressão longa de um comentário abre a denúncia do comentário', async () => {
    const post = photoPost();
    const other = thread({ body: 'Comentário ofensivo' });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: `/pessoal/inicio/p/${post.id}`,
      configure: (fake) => {
        fake.on(`GET /v1/posts/${post.id}`, { status: 200, body: post });
        fake.on(`GET /v1/posts/${post.id}/comments`, {
          status: 200,
          body: { items: [other], nextCursor: null },
        });
      },
    });
    await userEvent.longPress(await screen.findByTestId(`comment-${other.id}`));
    await userEvent.press(screen.getByRole('button', { name: 'Denunciar' }));
    expect(
      await screen.findByRole('header', {
        name: 'Por que você está denunciando este comentário?',
      }),
    ).toBeOnTheScreen();
  });
});

describe('Contas bloqueadas (X.2)', () => {
  it('Conta → "Contas bloqueadas": @ e data, só para o dono; Desbloquear avisa que não refaz conexão nem follows', async () => {
    const alert = answerAlerts('Desbloquear');
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/conta',
      configure: (fake) => {
        fake.on('GET /v1/me/blocks', {
          status: 200,
          body: { items: [blockedAccount()], nextCursor: null },
        });
        fake.on('DELETE /v1/me/blocks/caio.r', { status: 204 });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Contas bloqueadas' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/conta/bloqueados');
    });
    expect(await screen.findByText('caio.r')).toBeOnTheScreen();
    expect(screen.getByText(BLOCKED_AT_LABEL)).toBeOnTheScreen();
    expect(screen.getByText(OWN_LIST_NOTE)).toBeOnTheScreen();

    await userEvent.press(screen.getByRole('button', { name: 'Desbloquear @caio.r' }));
    expect(alert).toHaveBeenCalledWith('Desbloquear @caio.r?', UNBLOCK_MESSAGE, expect.any(Array));
    expect(UNBLOCK_MESSAGE).toMatch(/a conexão e os follows desfeitos no bloqueio não voltam/);
    await waitFor(() => {
      expect(api.callsTo('DELETE /v1/me/blocks/caio.r')).toHaveLength(1);
    });
    expect(await screen.findByText('Você desbloqueou @caio.r.')).toBeOnTheScreen();
    expect(
      await screen.findByRole('header', { name: 'Nenhuma conta bloqueada' }),
    ).toBeOnTheScreen();
  });

  it('PROX-65 (R1-PO-1; ux.md §11.18): cada linha tem o (Desbloquear) e o ⋯, nessa ordem; o ⋯ abre "Perfil de @caio.r" só com "Denunciar" e o "Cancelar", que não navega', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/conta/bloqueados',
      configure: (fake) => {
        fake.on('GET /v1/me/blocks', {
          status: 200,
          body: { items: [blockedAccount()], nextCursor: null },
        });
      },
    });
    const row = await screen.findByTestId('user-row-caio.r');
    // Ordem de leitura: a linha (o @ e a data), "Desbloquear @caio.r" e "Mais opções para @caio.r".
    expect(within(row).getByLabelText(`@caio.r, ${BLOCKED_AT_LABEL}`)).toBeOnTheScreen();
    expect(
      within(row)
        .getAllByRole('button')
        .map((node) => String(node.props.accessibilityLabel)),
    ).toEqual(['Desbloquear @caio.r', 'Mais opções para @caio.r']);
    // A data quebra em até 2 linhas (o ⋯ tira espaço do texto); o @ fica em 1.
    const date = within(row).getByText(BLOCKED_AT_LABEL);
    expect(date.props.numberOfLines).toBe(2);
    // ux.md §11.20, S4: o espaço não separável entre o dia e o mês. O `getByText` normaliza os
    // espaços, então o texto cru confere o caractere.
    expect(date.props.children).toBe(BLOCKED_AT_LABEL);

    await userEvent.press(screen.getByTestId('bloqueados-mais-caio.r'));
    expect(screen.getByRole('header', { name: 'Perfil de @caio.r' })).toBeOnTheScreen();
    expect(menuLabels('blocked-menu')).toEqual(['Denunciar', 'Cancelar']);
    await userEvent.press(
      within(screen.getByTestId('blocked-menu')).getByRole('button', { name: 'Cancelar' }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId('blocked-menu')).not.toBeOnTheScreen();
    });
    expect(screen).toHavePathname('/conta/bloqueados');
    expect(screen.getByTestId('user-row-caio.r')).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/reports')).toHaveLength(0);
    expect(api.callsTo('DELETE /v1/me/blocks/caio.r')).toHaveLength(0);
  });

  it('PROX-65 (R1-PO-1; ux.md §11.18): "Denunciar" no ⋯ abre /denunciar com a conta; o 202 avisa e volta à lista, com a linha', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/conta/bloqueados',
      configure: (fake) => {
        fake.on('GET /v1/me/blocks', {
          status: 200,
          body: { items: [blockedAccount()], nextCursor: null },
        });
        fake.on('POST /v1/reports', { status: 202 });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Mais opções para @caio.r' }));
    await userEvent.press(screen.getByRole('button', { name: 'Denunciar' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/denunciar');
    });
    expect(screen).toHaveSearchParams({ alvo: 'conta', handle: 'caio.r' });
    expect(
      await screen.findByRole('header', { name: 'Por que você está denunciando @caio.r?' }),
    ).toBeOnTheScreen();

    await userEvent.press(screen.getByRole('radio', { name: 'Assédio ou bullying' }));
    await userEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => {
      expect(api.callsTo('POST /v1/reports')[0]?.body).toEqual({
        target: { type: 'account', handle: 'caio.r' },
        reason: 'harassment',
      });
    });
    expect(await screen.findByText(REPORT_SENT_MESSAGE)).toBeOnTheScreen();
    await waitFor(() => {
      expect(screen).toHavePathname('/conta/bloqueados');
    });
    // A conta continua bloqueada: a linha e o ⋯ ficam.
    expect(screen.getByTestId('user-row-caio.r')).toBeOnTheScreen();
    expect(screen.getByTestId('bloqueados-mais-caio.r')).toBeOnTheScreen();
  });

  it('PROX-65 (R1-PO-1; ux.md §11.18): o 404 (conta excluída) avisa "Este perfil não está mais disponível." e volta à lista, com a linha até a próxima atualização', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/conta/bloqueados',
      configure: (fake) => {
        fake.on('GET /v1/me/blocks', {
          status: 200,
          body: { items: [blockedAccount()], nextCursor: null },
        });
        fake.on('POST /v1/reports', NOT_FOUND);
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Mais opções para @caio.r' }));
    await userEvent.press(screen.getByRole('button', { name: 'Denunciar' }));
    await userEvent.press(await screen.findByRole('radio', { name: 'Spam ou golpe' }));
    await userEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    expect(await screen.findByText(PROFILE_GONE_MESSAGE)).toBeOnTheScreen();
    await waitFor(() => {
      expect(screen).toHavePathname('/conta/bloqueados');
    });
    expect(screen.getByTestId('user-row-caio.r')).toBeOnTheScreen();
  });

  it('X.2: o criador também tem a lista de bloqueados', async () => {
    const { api } = await renderApp({
      signedInAs: creatorMe(),
      initialUrl: '/conta/bloqueados',
      configure: (fake) => {
        fake.on('GET /v1/me/blocks', { status: 200, body: { items: [], nextCursor: null } });
      },
    });
    expect(
      await screen.findByRole('header', { name: 'Nenhuma conta bloqueada' }),
    ).toBeOnTheScreen();
    expect(api.callsTo('GET /v1/me/blocks')).toHaveLength(1);
  });

  it('PROX-65 (R1-PO-1; ux.md §11.18, "Tipo de conta"): o criador também denuncia pelo ⋯ de "Contas bloqueadas", com o mesmo formulário', async () => {
    const { api } = await renderApp({
      signedInAs: creatorMe(),
      initialUrl: '/conta/bloqueados',
      configure: (fake) => {
        fake.on('GET /v1/me/blocks', {
          status: 200,
          body: { items: [blockedAccount()], nextCursor: null },
        });
        fake.on('POST /v1/reports', { status: 202 });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Mais opções para @caio.r' }));
    expect(menuLabels('blocked-menu')).toEqual(['Denunciar', 'Cancelar']);
    await userEvent.press(screen.getByRole('button', { name: 'Denunciar' }));
    expect(
      await screen.findByRole('header', { name: 'Por que você está denunciando @caio.r?' }),
    ).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('radio', { name: 'Spam ou golpe' }));
    await userEvent.press(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => {
      expect(api.callsTo('POST /v1/reports')[0]?.body).toEqual({
        target: { type: 'account', handle: 'caio.r' },
        reason: 'spam',
      });
    });
    await waitFor(() => {
      expect(screen).toHavePathname('/conta/bloqueados');
    });
  });

  it.each([
    [
      '503',
      { status: 503, body: { code: 'SERVICE_UNAVAILABLE', message: 'x' } },
      'Algo deu errado do nosso lado. Tente de novo.',
    ],
    ['sem rede', null, OFFLINE_MESSAGE],
  ] as const)(
    'PROX-65 (R1-PO-1; ux.md §11.18): pelo ⋯ de "Contas bloqueadas", o %s no "Enviar" fica na linha de erro do formulário (a rota é um modal nativo), anunciado uma vez, sem Toast; o formulário continua com o motivo',
    async (_case, reply, message) => {
      const announce = jest.mocked(AccessibilityInfo.announceForAccessibility);
      await renderApp({
        signedInAs: personalMe(),
        initialUrl: '/conta/bloqueados',
        configure: (fake) => {
          fake.on('GET /v1/me/blocks', {
            status: 200,
            body: { items: [blockedAccount()], nextCursor: null },
          });
          fake.on('POST /v1/reports', () => {
            if (reply === null) throw new Error('sem rede');
            return reply;
          });
        },
      });
      await userEvent.press(
        await screen.findByRole('button', { name: 'Mais opções para @caio.r' }),
      );
      await userEvent.press(screen.getByRole('button', { name: 'Denunciar' }));
      await userEvent.press(await screen.findByRole('radio', { name: 'Assédio ou bullying' }));
      announce.mockClear();
      await userEvent.press(screen.getByRole('button', { name: 'Enviar' }));
      expect(await screen.findByTestId('denunciar-erro')).toHaveTextContent(message);
      // Uma vez só: a linha, sem um Toast com o mesmo texto por trás do modal.
      expect(screen.getAllByText(message)).toHaveLength(1);
      expect(announce.mock.calls.filter(([text]) => text === message)).toHaveLength(1);
      expect(screen).toHavePathname('/denunciar');
      expect(screen.getByRole('radio', { name: 'Assédio ou bullying' })).toBeChecked();
      expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
    },
  );
});
