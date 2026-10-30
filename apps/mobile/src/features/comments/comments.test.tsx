import type { Post } from '@sussurro/shared';
import { userEvent } from '@testing-library/react-native';
import { screen, waitFor, within } from 'expo-router/testing-library';
import { Alert, type AlertButton } from 'react-native';

import { DELETE_COMMENT_TITLE } from './useComments';
import { NetworkError } from '../../lib/api/errors';
import { creatorMe, type FakeApi, personalMe } from '../../test-utils/fake-api';
import {
  AUTHORS,
  comment,
  feedPage,
  photoPost,
  thread,
  uuid,
} from '../../test-utils/post-fixtures';
import { renderApp } from '../../test-utils/render-app';

afterEach(() => {
  jest.restoreAllMocks();
});

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

function withComments(fake: FakeApi, post: Post, threads = [thread()]) {
  fake.on(`GET /v1/posts/${post.id}`, { status: 200, body: post });
  fake.on(`GET /v1/posts/${post.id}/comments`, {
    status: 200,
    body: { items: threads, nextCursor: null },
  });
}

/** Feed com um post de foto e a folha de comentários aberta por "Ver todos os N comentários". */
async function openSheetFromFeed(
  post: Post,
  configure: (fake: FakeApi) => void,
  me = personalMe(),
) {
  const result = await renderApp({
    signedInAs: me,
    configure: (fake) => {
      fake.on('GET /v1/feed', { status: 200, body: feedPage([post]) });
      configure(fake);
    },
  });
  const card = within(await screen.findByTestId(`post-${post.id}`));
  await userEvent.press(card.getByText(/^Ver /));
  await waitFor(() => {
    expect(screen).toHavePathname(`/comentarios/${post.id}`);
  });
  await screen.findByRole('header', { name: 'Comentários' });
  return result;
}

describe('comentários (história 2.8)', () => {
  it('2.8 CA1/CA2: lista com respostas; comentar e responder enviam à API e o número do post acompanha', async () => {
    const post = photoPost({ commentCount: 2 });
    const root = thread({
      body: 'Que luz bonita!',
      replies: [
        comment({ body: 'Obrigada!', author: { ...AUTHORS.marinac, profileVisible: true } }),
      ],
    });
    const created = comment({
      body: 'Lindo demais',
      author: { ...AUTHORS.helena, profileVisible: true },
      canDelete: true,
    });
    const reply = comment({
      body: 'Concordo',
      parentId: root.id,
      author: { ...AUTHORS.helena, profileVisible: true },
      canDelete: true,
    });
    const { api } = await openSheetFromFeed(post, (fake) => {
      withComments(fake, post, [root]);
      fake.on(`POST /v1/posts/${post.id}/comments`, ({ body }) =>
        (body as { parentId?: string }).parentId === undefined
          ? { status: 201, body: created }
          : { status: 201, body: reply },
      );
    });
    expect(await screen.findByText('Que luz bonita!')).toBeOnTheScreen();
    expect(screen.getByText('Obrigada!')).toBeOnTheScreen();

    await userEvent.type(screen.getByLabelText('Comentário'), 'Lindo demais');
    await userEvent.press(screen.getByRole('button', { name: 'Publicar' }));
    expect(await screen.findByText('Lindo demais')).toBeOnTheScreen();
    expect(api.callsTo(`POST /v1/posts/${post.id}/comments`)[0]?.body).toEqual({
      body: 'Lindo demais',
    });

    await userEvent.press(screen.getByRole('button', { name: 'Responder a @juprado' }));
    await userEvent.type(screen.getByLabelText('Resposta para @juprado'), 'Concordo');
    await userEvent.press(screen.getByRole('button', { name: 'Publicar' }));
    expect(await screen.findByText('Concordo')).toBeOnTheScreen();
    expect(api.callsTo(`POST /v1/posts/${post.id}/comments`)[1]?.body).toEqual({
      body: 'Concordo',
      parentId: root.id,
    });

    // O feed mostra o número novo ao fechar a folha.
    await userEvent.press(screen.getByRole('button', { name: 'Fechar' }));
    expect(await screen.findByText('Ver todos os 4 comentários')).toBeOnTheScreen();
  });

  it('2.8 CA4: apagar (pressão longa → Excluir → confirmação) tira o comentário e as respostas da conta', async () => {
    const post = photoPost({ commentCount: 3 });
    const mine = thread({
      body: 'Meu comentário',
      author: { ...AUTHORS.helena, profileVisible: true },
      canDelete: true,
      replies: [
        comment({ body: 'Resposta', author: { ...AUTHORS.marinac, profileVisible: true } }),
      ],
    });
    const other = thread({ body: 'De outra pessoa' });
    const alert = answerAlerts('Excluir');
    const { api } = await openSheetFromFeed(post, (fake) => {
      withComments(fake, post, [mine, other]);
      fake.on(`DELETE /v1/comments/${mine.id}`, { status: 204 });
    });
    // Fase 3b: a pressão longa abre o menu de ações (D-UX14) e "Excluir" pede confirmação.
    await userEvent.longPress(await screen.findByTestId(`comment-${mine.id}`));
    await userEvent.press(screen.getByRole('button', { name: 'Excluir' }));
    await waitFor(() => {
      expect(alert).toHaveBeenCalledWith(DELETE_COMMENT_TITLE, undefined, expect.any(Array));
    });
    await waitFor(() => {
      expect(screen.queryByText('Meu comentário')).not.toBeOnTheScreen();
    });
    expect(screen.queryByText('Resposta')).not.toBeOnTheScreen();
    expect(api.callsTo(`DELETE /v1/comments/${mine.id}`)).toHaveLength(1);
    // Sem canDelete, a pressão longa não oferece "Excluir".
    await userEvent.longPress(screen.getByTestId(`comment-${other.id}`));
    expect(screen.getByRole('button', { name: 'Denunciar' })).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Excluir' })).not.toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Cancelar' }));
    await userEvent.press(screen.getByRole('button', { name: 'Fechar' }));
    expect(await screen.findByText('Ver 1 comentário')).toBeOnTheScreen();
  });

  it('PERM-10c (D11): o @ só é tocável com profileVisible e abre o perfil na aba de origem', async () => {
    const post = photoPost();
    const visible = thread({ body: 'Oi', author: { ...AUTHORS.juprado, profileVisible: true } });
    const hidden = thread({ body: 'Olá', author: { ...AUTHORS.marinac, profileVisible: false } });
    await openSheetFromFeed(post, (fake) => {
      withComments(fake, post, [visible, hidden]);
      fake.on('GET /v1/users/juprado', {
        status: 200,
        body: {
          handle: 'juprado',
          name: 'Juliana Prado',
          bio: null,
          avatarUrl: null,
          accountType: 'personal',
          counts: { posts: 2, connections: 1, creators: 0 },
        },
      });
      fake.on('GET /v1/users/juprado/posts', {
        status: 200,
        body: { items: [], nextCursor: null },
      });
    });
    await screen.findByText('Oi');
    expect(screen.queryByRole('link', { name: 'Perfil de @marinac' })).not.toBeOnTheScreen();
    expect(screen.getByTestId(`comment-${hidden.id}-author-text`)).toHaveTextContent('marinac');
    await userEvent.press(screen.getByRole('link', { name: 'Perfil de @juprado' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio/u/juprado');
    });
    expect(await screen.findByRole('header', { name: 'juprado' })).toBeOnTheScreen();
  });

  it('envio que falha fica "Não publicado." com "Tentar de novo"', async () => {
    const post = photoPost();
    let fail = true;
    const created = comment({ body: 'Volta', author: { ...AUTHORS.helena, profileVisible: true } });
    await openSheetFromFeed(post, (fake) => {
      withComments(fake, post, []);
      fake.on(`POST /v1/posts/${post.id}/comments`, () => {
        if (fail) throw new NetworkError();
        return { status: 201, body: created };
      });
    });
    expect(
      await screen.findByText('Ainda não há comentários. Comece a conversa.'),
    ).toBeOnTheScreen();
    await userEvent.type(screen.getByLabelText('Comentário'), 'Volta');
    await userEvent.press(screen.getByRole('button', { name: 'Publicar' }));
    expect(await screen.findByText('Não publicado.')).toBeOnTheScreen();
    fail = false;
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => {
      expect(screen.queryByText('Não publicado.')).not.toBeOnTheScreen();
    });
    expect(screen.getByText('Volta')).toBeOnTheScreen();
  });

  it('X.3: EMAIL_NOT_VERIFIED ao comentar mostra a mensagem com a ação "Verificar e-mail"', async () => {
    const post = photoPost();
    await openSheetFromFeed(
      post,
      (fake) => {
        withComments(fake, post, []);
        fake.on(`POST /v1/posts/${post.id}/comments`, {
          status: 403,
          body: { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' },
        });
      },
      personalMe({ emailVerified: false }),
    );
    // Aviso fixo acima do campo, e ler continua liberado.
    expect(await screen.findByTestId('email-not-verified')).toBeOnTheScreen();
    await userEvent.type(screen.getByLabelText('Comentário'), 'Oi');
    await userEvent.press(screen.getByRole('button', { name: 'Publicar' }));
    const toast = await screen.findByTestId('toast');
    expect(
      within(toast).getByText('Confirme seu e-mail para publicar e comentar.'),
    ).toBeOnTheScreen();
    expect(within(toast).getByRole('button', { name: 'Verificar e-mail' })).toBeOnTheScreen();
    // O comentário recusado não fica na lista como enviado.
    await waitFor(() => {
      expect(screen.queryByText('Oi')).not.toBeOnTheScreen();
    });
  });
});

describe('comentários do criador (A-06)', () => {
  it('no próprio post o criador não tem campo de primeiro nível: só responde e apaga', async () => {
    const own = photoPost({
      isOwn: true,
      author: AUTHORS.cozinhadabia,
      commentCount: 1,
    });
    const fromFollower = thread({
      body: 'Que receita boa!',
      author: { ...AUTHORS.juprado, profileVisible: false },
      canDelete: true,
    });
    const reply = comment({
      body: 'Obrigada!',
      parentId: fromFollower.id,
      author: { ...AUTHORS.cozinhadabia, profileVisible: true },
      canDelete: true,
    });
    const { api } = await renderApp({
      signedInAs: creatorMe(),
      // Detalhe do post no perfil do criador: os comentários ficam abaixo do post.
      initialUrl: `/criador/perfil/p/${own.id}`,
      configure: (fake) => {
        withComments(fake, own, [fromFollower]);
        fake.on(`POST /v1/posts/${own.id}/comments`, { status: 201, body: reply });
      },
    });
    expect(await screen.findByText('Que receita boa!')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Comentário')).not.toBeOnTheScreen();
    // O @ da pessoa não é tocável para o criador (o perfil pessoal não é visível para ele).
    expect(screen.queryByRole('link', { name: 'Perfil de @juprado' })).not.toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Responder a @juprado' }));
    await userEvent.type(screen.getByLabelText('Resposta para @juprado'), 'Obrigada!');
    await userEvent.press(screen.getByRole('button', { name: 'Publicar' }));
    expect(await screen.findByText('Obrigada!')).toBeOnTheScreen();
    expect(api.callsTo(`POST /v1/posts/${own.id}/comments`)[0]?.body).toEqual({
      body: 'Obrigada!',
      parentId: fromFollower.id,
    });
  });

  it('em post de outra conta o criador só lê (sem campo e sem "Responder")', async () => {
    const other = photoPost({ author: AUTHORS.cozinhadabia, isOwn: false, id: uuid() });
    await renderApp({
      signedInAs: creatorMe({ handle: 'trilhasdosul' }),
      initialUrl: `/criador/perfil/p/${other.id}`,
      configure: (fake) => {
        withComments(fake, other, [thread({ body: 'Lindo' })]);
      },
    });
    expect(await screen.findByText('Lindo')).toBeOnTheScreen();
    expect(screen.queryByLabelText('Comentário')).not.toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: /^Responder/ })).not.toBeOnTheScreen();
  });

  it('A-06: o criador não vê o coração ativo no próprio post (o servidor responderia 403)', async () => {
    const own = photoPost({ isOwn: true, author: AUTHORS.cozinhadabia, likeCount: 12 });
    await renderApp({
      signedInAs: creatorMe(),
      initialUrl: `/criador/perfil/p/${own.id}`,
      configure: (fake) => {
        withComments(fake, own, []);
      },
    });
    const card = within(await screen.findByTestId(`post-${own.id}`));
    expect(card.getByText('12 curtidas')).toBeOnTheScreen();
    expect(card.queryByRole('button', { name: 'Curtir' })).not.toBeOnTheScreen();
    expect(card.queryByRole('button', { name: 'Curtido' })).not.toBeOnTheScreen();
  });
});
