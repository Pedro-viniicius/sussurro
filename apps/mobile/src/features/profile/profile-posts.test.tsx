import { userEvent } from '@testing-library/react-native';
import { screen, waitFor, within } from 'expo-router/testing-library';
import { Alert, type AlertButton, Linking } from 'react-native';

import { AVATAR_REMOVED_MESSAGE, AVATAR_UPDATED_MESSAGE } from './useAvatar';
import { PROFILE_UNAVAILABLE_TITLE } from './UserProfileScreen';
import { LEGAL_URLS } from '../../lib/legal';
import { creatorMe, personalMe } from '../../test-utils/fake-api';
import { createFakeMedia, pickedImages } from '../../test-utils/fake-media';
import { AUTHORS, feedPage, media, photoPost, textPost } from '../../test-utils/post-fixtures';
import { renderApp } from '../../test-utils/render-app';

afterEach(() => {
  jest.restoreAllMocks();
});

describe('abas do perfil (história 2.6)', () => {
  it('2.6 CA3/MID-09: o dono vê a grade 3:4 com os tiles em processing e failed, e os textos', async () => {
    const ready = photoPost({ isOwn: true, author: AUTHORS.helena });
    const processing = photoPost({
      isOwn: true,
      author: AUTHORS.helena,
      status: 'processing',
      publishedAt: null,
      media: [media(0, { status: 'processing', url: null, thumbUrl: null })],
    });
    const failed = photoPost({
      isOwn: true,
      author: AUTHORS.helena,
      status: 'failed',
      publishedAt: null,
      media: [media(0, { status: 'failed', url: null, thumbUrl: null })],
    });
    const text = textPost({ isOwn: true, author: AUTHORS.helena, text: 'Meu primeiro texto' });
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        fake.on('GET /v1/users/helena/posts', ({ query }) => ({
          status: 200,
          body: {
            items:
              query.type === 'photo'
                ? [processing, failed, ready]
                : query.type === 'text'
                  ? [text]
                  : [],
            nextCursor: null,
          },
        }));
      },
    });
    expect(await screen.findByText('Processando')).toBeOnTheScreen();
    expect(screen.getByText('Falhou')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Publicação com 2 fotos' })).toBeOnTheScreen();
    // Números reais do perfil (counts do GET /me).
    expect(screen.getByLabelText('5 publicações')).toBeOnTheScreen();
    expect(api.callsTo('GET /v1/users/helena/posts')[0]?.query).toMatchObject({ type: 'photo' });

    await userEvent.press(screen.getByRole('tab', { name: 'Textos' }));
    expect(await screen.findByText('Meu primeiro texto')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('tab', { name: 'Reels' }));
    expect(
      await screen.findByRole('header', { name: 'Compartilhe seu primeiro reel' }),
    ).toBeOnTheScreen();
  });

  it('tile que falhou: tocar oferece excluir', async () => {
    const failed = photoPost({
      isOwn: true,
      author: AUTHORS.helena,
      status: 'failed',
      publishedAt: null,
      media: [media(0, { status: 'failed', url: null, thumbUrl: null })],
    });
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_t, _m, buttons?: AlertButton[]) => {
        buttons?.find((button) => button.style === 'destructive')?.onPress?.();
      });
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        fake.on('GET /v1/users/helena/posts', {
          status: 200,
          body: { items: [failed], nextCursor: null },
        });
        fake.on(`DELETE /v1/posts/${failed.id}`, { status: 204 });
      },
    });
    await userEvent.press(
      await screen.findByRole('button', { name: 'Publicação com foto, não foi possível publicar' }),
    );
    expect(alert).toHaveBeenCalledWith(
      'Excluir publicação?',
      'Não dá para desfazer.',
      expect.any(Array),
    );
    await waitFor(() => {
      expect(api.callsTo(`DELETE /v1/posts/${failed.id}`)).toHaveLength(1);
    });
    expect(
      await screen.findByRole('header', { name: 'Compartilhe sua primeira foto' }),
    ).toBeOnTheScreen();
  });

  it('2.6 CA1: perfil de criador aberto pelo @ no feed, com as abas e sem botões do dono', async () => {
    const fromCreator = photoPost({ author: AUTHORS.cozinhadabia });
    const creatorText = textPost({ author: AUTHORS.cozinhadabia, text: 'Receita do pão' });
    await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/feed', { status: 200, body: feedPage([fromCreator]) });
        fake.on('GET /v1/users/cozinhadabia', {
          status: 200,
          body: {
            handle: 'cozinhadabia',
            name: 'Beatriz Lemos',
            bio: 'Receitas de casa, sem pressa.',
            avatarUrl: null,
            accountType: 'creator',
            counts: { posts: 6, followers: 2418 },
            // Fase 3a: o perfil de criador traz followedByMe (contrato da API).
            followedByMe: false,
          },
        });
        fake.on('GET /v1/users/cozinhadabia/posts', ({ query }) => ({
          status: 200,
          body: { items: query.type === 'photo' ? [fromCreator] : [creatorText], nextCursor: null },
        }));
      },
    });
    await userEvent.press(
      await screen.findByRole('button', { name: 'Abrir perfil de @cozinhadabia, Criador' }),
    );
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio/u/cozinhadabia');
    });
    expect(await screen.findByRole('header', { name: 'cozinhadabia' })).toBeOnTheScreen();
    expect(screen.getByLabelText('2.418 seguidores')).toBeOnTheScreen();
    expect(screen.getByText('Criador de conteúdo · não segue ninguém')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Editar perfil' })).not.toBeOnTheScreen();
    expect(await screen.findByRole('button', { name: 'Publicação com 2 fotos' })).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('tab', { name: 'Textos' }));
    expect(await screen.findByText('Receita do pão')).toBeOnTheScreen();
    // A aba Início continua ativa (rota dentro da aba).
    expect(screen.getByRole('tab', { name: 'Início' })).toBeSelected();
  });

  it('PERM-13: conta pessoal sem conexão recebe 404 → "Perfil indisponível"', async () => {
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/inicio/u/estranho',
      configure: (fake) => {
        fake.on('GET /v1/users/estranho', {
          status: 404,
          body: { code: 'NOT_FOUND', message: 'Not found' },
        });
      },
    });
    expect(
      await screen.findByRole('header', { name: PROFILE_UNAVAILABLE_TITLE }),
    ).toBeOnTheScreen();
    expect(
      screen.getByText('Contas pessoais só aparecem para as conexões delas.'),
    ).toBeOnTheScreen();
  });

  it('outro perfil sem publicações: "Nenhuma foto ainda."', async () => {
    await renderApp({
      signedInAs: creatorMe(),
      initialUrl: '/criador/perfil/u/trilhasdosul',
      configure: (fake) => {
        fake.on('GET /v1/users/trilhasdosul', {
          status: 200,
          body: {
            handle: 'trilhasdosul',
            name: 'Rafael Duarte',
            bio: null,
            avatarUrl: null,
            accountType: 'creator',
            counts: { posts: 0, followers: 8903 },
            followedByMe: false,
          },
        });
        fake.on('GET /v1/users/trilhasdosul/posts', {
          status: 200,
          body: { items: [], nextCursor: null },
        });
      },
    });
    expect(await screen.findByRole('header', { name: 'Nenhuma foto ainda.' })).toBeOnTheScreen();
    expect(screen.getByLabelText('8.903 seguidores')).toBeOnTheScreen();
  });
});

describe('foto de perfil (história 2.4)', () => {
  const AVATAR = 'https://cdn.teste/avatars/helena.jpg';
  const UPLOAD_ID = '01a189e0-af57-7000-8000-0000000a0a0a';

  it('2.4 CA1: escolher → upload-url → PUT → PUT /me/avatar até sair de processing → a foto aparece', async () => {
    const fakeMedia = createFakeMedia();
    fakeMedia.queuePick(pickedImages(1));
    let meCalls = 0;
    let avatarCalls = 0;
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons?: AlertButton[]) => {
      buttons?.find((button) => button.text === 'Escolher da galeria')?.onPress?.();
    });
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
      media: fakeMedia,
      configure: (fake) => {
        fake.on('GET /v1/me', () => {
          meCalls += 1;
          return { status: 200, body: personalMe(meCalls > 1 ? { avatarUrl: AVATAR } : {}) };
        });
        fake.on('POST /v1/me/avatar/upload-url', ({ body }) => ({
          status: 201,
          body: {
            uploadId: UPLOAD_ID,
            method: 'PUT',
            url: 'https://s3.teste/incoming/avatars/x?X-Amz-Signature=1',
            headers: {
              'Content-Type': 'image/jpeg',
              'Content-Length': String((body as { sizeBytes: number }).sizeBytes),
            },
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
        }));
        fake.on('PUT /v1/me/avatar', () => {
          avatarCalls += 1;
          return {
            status: 200,
            body: {
              uploadId: UPLOAD_ID,
              status: avatarCalls < 3 ? 'processing' : 'ready',
              avatarUrl: avatarCalls < 3 ? null : AVATAR,
            },
          };
        });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Editar perfil' }));
    await userEvent.press(await screen.findByRole('button', { name: 'Alterar foto' }));
    expect(await screen.findByText(AVATAR_UPDATED_MESSAGE)).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/me/avatar/upload-url')[0]?.body).toMatchObject({
      mime: 'image/jpeg',
    });
    expect(fakeMedia.uploads[0]?.headers['Content-Type']).toBe('image/jpeg');
    expect(api.callsTo('PUT /v1/me/avatar')).toHaveLength(3);
    expect(api.callsTo('PUT /v1/me/avatar')[0]?.body).toEqual({ uploadId: UPLOAD_ID });
    expect(screen.getByTestId('editar-avatar-imagem-photo').props.source).toEqual({ uri: AVATAR });
  });

  it('2.4 CA2: "Remover foto" confirma e volta às iniciais sobre o pastel', async () => {
    let removed = false;
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons?: AlertButton[]) => {
      buttons
        ?.find((button) => button.text === 'Remover foto' || button.text === 'Remover')
        ?.onPress?.();
    });
    const { api } = await renderApp({
      signedInAs: personalMe({ avatarUrl: AVATAR }),
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        fake.on('GET /v1/me', () => ({
          status: 200,
          body: personalMe({ avatarUrl: removed ? null : AVATAR }),
        }));
        fake.on('DELETE /v1/me/avatar', () => {
          removed = true;
          return { status: 204 };
        });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Editar perfil' }));
    expect(await screen.findByTestId('editar-avatar-imagem-photo')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Alterar foto' }));
    expect(await screen.findByText(AVATAR_REMOVED_MESSAGE)).toBeOnTheScreen();
    expect(api.callsTo('DELETE /v1/me/avatar')).toHaveLength(1);
    expect(screen.queryByTestId('editar-avatar-imagem-photo')).not.toBeOnTheScreen();
    expect(within(screen.getByTestId('editar-avatar-imagem')).getByText('HS')).toBeOnTheScreen();
  });
});

describe('links legais (ux.md §4.7 e §8)', () => {
  it('Conta: "Termos de uso" e "Política de privacidade" abrem o site público', async () => {
    // O openURL já é um jest.fn no preset do React Native: zera as chamadas de outros testes.
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    open.mockClear();
    await renderApp({ signedInAs: personalMe(), initialUrl: '/conta' });
    await userEvent.press(await screen.findByRole('button', { name: 'Termos de uso' }));
    await userEvent.press(screen.getByRole('button', { name: 'Política de privacidade' }));
    expect(open.mock.calls.map(([url]) => url)).toEqual([LEGAL_URLS.terms, LEGAL_URLS.privacy]);
    expect(LEGAL_URLS).toEqual({
      terms: 'https://sussurro-site.vercel.app/termos',
      privacy: 'https://sussurro-site.vercel.app/privacidade',
    });
  });

  it('Cadastro: o rodapé tem os links para os Termos e a Política', async () => {
    // O openURL já é um jest.fn no preset do React Native: zera as chamadas de outros testes.
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    open.mockClear();
    await renderApp({ initialUrl: '/cadastro' });
    await userEvent.press(await screen.findByRole('link', { name: 'Termos de Uso' }));
    await userEvent.press(screen.getByRole('link', { name: 'Política de Privacidade' }));
    expect(open.mock.calls.map(([url]) => url)).toEqual([LEGAL_URLS.terms, LEGAL_URLS.privacy]);
  });
});
