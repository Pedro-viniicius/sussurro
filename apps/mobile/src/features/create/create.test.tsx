import textCount from '@sussurro/shared/fixtures/text-count.json';
import { fireEvent, userEvent } from '@testing-library/react-native';
import { useNetworkState } from 'expo-network';
import { screen, waitFor, within } from 'expo-router/testing-library';
import { Alert, type AlertButton } from 'react-native';

import { SHARE_OFFLINE_MESSAGE } from './CreateScreen';
import { PUBLISHED_MESSAGE } from './PublishingProvider';
import { PHOTO_LIMIT_MESSAGE } from './selection';
import { NetworkError } from '../../lib/api/errors';
import { creatorMe, type FakeApi, personalMe } from '../../test-utils/fake-api';
import { createFakeMedia, type FakeMedia, pickedImages } from '../../test-utils/fake-media';
import {
  AUTHORS,
  draft,
  feedPage,
  photoPost,
  textPost,
  uuid,
} from '../../test-utils/post-fixtures';
import { renderApp } from '../../test-utils/render-app';

interface TextFixture {
  id: string;
  label: string;
  parts: { text: string; times?: number }[];
  count: number;
  valid: boolean;
}

/** Monta o texto de um caso das fixtures compartilhadas (o mesmo JSON da API e do shared). */
function fixtureText(fixture: TextFixture): string {
  return fixture.parts.map((part) => part.text.repeat(part.times ?? 1)).join('');
}

const FIXTURES = textCount.cases as TextFixture[];

afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(useNetworkState).mockReturnValue({ isConnected: true, isInternetReachable: true });
});

async function openCreate(options: Parameters<typeof renderApp>[0] = {}) {
  const result = await renderApp({ signedInAs: personalMe(), initialUrl: '/criar', ...options });
  await screen.findByRole('header', { name: 'Nova publicação' });
  return result;
}

async function switchToText() {
  await userEvent.press(screen.getByRole('tab', { name: 'Texto' }));
  return screen.getByLabelText('Texto da publicação');
}

const share = () => screen.getByRole('button', { name: 'Compartilhar' });

describe('Criar: modo TEXTO (história 2.1)', () => {
  it.each(FIXTURES.map((fixture) => [`${fixture.id} ${fixture.label}`, fixture] as const))(
    'TXT-02/TXT-03: %s → contador igual ao da API e "Compartilhar" só se válido',
    async (_name, fixture) => {
      await openCreate();
      const input = await switchToText();
      await fireEvent.changeText(input, fixtureText(fixture));
      expect(screen.getByTestId('criar-contador')).toHaveTextContent(
        `${String(fixture.count)}/280`,
      );
      if (fixture.valid) expect(share()).toBeEnabled();
      else expect(share()).toBeDisabled();
    },
  );

  it('TXT-03: tons do contador (cinza até 260, preto de 261 a 280, danger acima)', async () => {
    await openCreate();
    const input = await switchToText();
    const counter = () => screen.getByTestId('criar-contador');
    await fireEvent.changeText(input, 'a'.repeat(260));
    expect(counter()).toHaveStyle({ color: '#737373' });
    await fireEvent.changeText(input, 'a'.repeat(261));
    expect(counter()).toHaveStyle({ color: '#000000' });
    await fireEvent.changeText(input, 'a'.repeat(280));
    expect(counter()).toHaveStyle({ color: '#000000' });
    expect(share()).toBeEnabled();
    await fireEvent.changeText(input, 'a'.repeat(281));
    expect(counter()).toHaveStyle({ color: '#D32F2F' });
    expect(share()).toBeDisabled();
  });

  it('TXT-01h/TXT-03: vazio, só espaços ou só invisíveis deixam "Compartilhar" desabilitado', async () => {
    await openCreate();
    const input = await switchToText();
    expect(share()).toBeDisabled();
    for (const blank of ['   ', '\n\n', '​​', ' ⁠ ']) {
      await fireEvent.changeText(input, blank);
      expect(share()).toBeDisabled();
    }
  });

  it('2.1 CA1: publica o texto, fecha o modal, mostra "Publicado." e põe o post no topo do feed (D9)', async () => {
    const created = textPost({ isOwn: true, author: AUTHORS.helena, text: 'Café coado e chuva.' });
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('POST /v1/posts', { status: 201, body: created });
      },
    });
    await userEvent.press(await screen.findByRole('tab', { name: 'Textos' }));
    await screen.findByTestId('caught-up-text');
    await userEvent.press(screen.getByRole('tab', { name: 'Criar publicação' }));
    const input = await switchToText();
    await userEvent.type(input, 'Café coado e chuva.');
    await userEvent.press(share());
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio');
    });
    expect(api.callsTo('POST /v1/posts')[0]?.body).toEqual({
      type: 'text',
      text: 'Café coado e chuva.',
    });
    expect(await screen.findByText(PUBLISHED_MESSAGE)).toBeOnTheScreen();
    expect(screen.getByText('Café coado e chuva.')).toBeOnTheScreen();
  });

  it('X.3: EMAIL_NOT_VERIFIED mostra a mensagem com a ação para "Verificar e-mail" e o reenvio', async () => {
    const { api } = await openCreate({
      signedInAs: personalMe({ emailVerified: false }),
      configure: (fake) => {
        fake.on('POST /v1/posts', {
          status: 403,
          body: { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' },
        });
        fake.on('POST /v1/me/email/verification', { status: 202 });
      },
    });
    // Aviso fixo enquanto o e-mail não está confirmado.
    expect(screen.getByTestId('email-not-verified')).toBeOnTheScreen();
    const input = await switchToText();
    await userEvent.type(input, 'Oi');
    await userEvent.press(share());
    const toast = await screen.findByTestId('toast');
    expect(
      within(toast).getByText('Confirme seu e-mail para publicar e comentar.'),
    ).toBeOnTheScreen();
    expect(screen.queryByText('EMAIL_NOT_VERIFIED')).not.toBeOnTheScreen();
    expect(screen).toHavePathname('/criar');
    await userEvent.press(within(toast).getByRole('button', { name: 'Verificar e-mail' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/verificar-email');
    });
    expect(await screen.findByRole('header', { name: 'Confirme seu e-mail' })).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Reenviar link' }));
    await waitFor(() => {
      expect(api.callsTo('POST /v1/me/email/verification')).toHaveLength(1);
    });
  });

  it('2.2 CA9: offline no Compartilhar mostra o Toast e mantém o modal aberto', async () => {
    jest
      .mocked(useNetworkState)
      .mockReturnValue({ isConnected: false, isInternetReachable: false });
    const { api } = await openCreate();
    const input = await switchToText();
    await userEvent.type(input, 'Sem rede');
    await userEvent.press(share());
    expect(await screen.findByText(SHARE_OFFLINE_MESSAGE)).toBeOnTheScreen();
    expect(screen).toHavePathname('/criar');
    expect(api.callsTo('POST /v1/posts')).toHaveLength(0);
  });

  it('2.2 CA9: queda de rede ao enviar também mostra "Sem internet…"', async () => {
    const { api } = await openCreate({
      configure: (fake) => {
        fake.on('POST /v1/posts', () => {
          throw new NetworkError();
        });
      },
    });
    const input = await switchToText();
    await userEvent.type(input, 'Sem rede');
    await userEvent.press(share());
    expect(await screen.findByText(SHARE_OFFLINE_MESSAGE)).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/posts')).toHaveLength(1);
    expect(screen).toHavePathname('/criar');
  });

  it('sair com conteúdo pede confirmação ("Descartar publicação?"); REEL habilitado desde a Fase 5', async () => {
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await openCreate();
    expect(screen.getByRole('tab', { name: 'Reel' })).toBeEnabled();
    const input = await switchToText();
    await userEvent.type(input, 'rascunho');
    await userEvent.press(screen.getByRole('button', { name: 'Fechar' }));
    expect(alert).toHaveBeenCalledWith('Descartar publicação?', undefined, expect.any(Array));
    expect(screen).toHavePathname('/criar');
  });
});

/** Configura rascunho, publish e a consulta do post (que passa por `processing`). */
function photoFlow(
  fake: FakeApi,
  postId: string,
  statuses: ('processing' | 'published' | 'failed')[],
) {
  fake.on('POST /v1/posts/drafts', ({ body }) => {
    const items = (body as { items: { sizeBytes: number }[] }).items;
    return {
      status: 201,
      body: draft(
        items.map((item) => item.sizeBytes),
        { postId },
      ),
    };
  });
  const processing = photoPost({
    id: postId,
    isOwn: true,
    status: 'processing',
    publishedAt: null,
  });
  fake.on(`POST /v1/posts/${postId}/publish`, { status: 200, body: processing });
  const queue = [...statuses];
  fake.on(`GET /v1/posts/${postId}`, () => {
    const status = queue.length > 1 ? queue.shift() : queue[0];
    return {
      status: 200,
      body: {
        ...processing,
        status,
        publishedAt: status === 'published' ? processing.createdAt : null,
      },
    };
  });
}

async function pickAndSelect(media: FakeMedia, count: number) {
  media.queuePick(pickedImages(count));
  await userEvent.press(screen.getByRole('button', { name: 'Escolher fotos do aparelho' }));
}

describe('Criar: modo FOTO (história 2.2)', () => {
  it('MID-01 (2.2 CA2): até 4 fotos numeradas; a 5ª mostra o Toast "Até 4 fotos por publicação."', async () => {
    const media = createFakeMedia();
    await openCreate({ media });
    expect(screen.getByText('Escolha até 4 imagens abaixo')).toBeOnTheScreen();
    await pickAndSelect(media, 4);
    for (const order of [1, 2, 3, 4]) {
      expect(
        screen.getByRole('button', { name: `Foto ${order}, ${order}ª selecionada` }),
      ).toBeSelected();
    }
    expect(screen.getByTestId('criar-previa')).toBeOnTheScreen();

    // Mais fotos do seletor: entram desmarcadas, com o aviso.
    await pickAndSelect(media, 1);
    expect(await screen.findByText(PHOTO_LIMIT_MESSAGE)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Foto 5' })).not.toBeSelected();
  });

  it('MID-01: tocar na 5ª recusa; desmarcar reorganiza os números', async () => {
    const media = createFakeMedia();
    await openCreate({ media });
    await pickAndSelect(media, 4);
    await pickAndSelect(media, 1);
    await userEvent.press(screen.getByRole('button', { name: 'Foto 5' }));
    expect(screen.getByRole('button', { name: 'Foto 5' })).not.toBeSelected();
    expect(screen.getAllByText(PHOTO_LIMIT_MESSAGE).length).toBeGreaterThan(0);
    // Desmarca a 1ª: a 2ª vira "1ª" e a 5ª pode entrar como 4ª.
    await userEvent.press(screen.getByRole('button', { name: 'Foto 1, 1ª selecionada' }));
    expect(screen.getByRole('button', { name: 'Foto 2, 1ª selecionada' })).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Foto 5' }));
    expect(screen.getByRole('button', { name: 'Foto 5, 4ª selecionada' })).toBeSelected();
  });

  it('MID-01..03/MID-09: rascunho → PUT de cada foto com os cabeçalhos assinados → publish → processing → published', async () => {
    const media = createFakeMedia();
    const postId = uuid();
    const { api } = await renderApp({
      signedInAs: personalMe(),
      media,
      configure: (fake) => {
        photoFlow(fake, postId, ['processing', 'processing', 'published']);
        fake.on('GET /v1/feed', { status: 200, body: feedPage([]) });
      },
    });
    await screen.findByTestId('caught-up-photo');
    await userEvent.press(screen.getByRole('tab', { name: 'Criar publicação' }));
    await screen.findByRole('header', { name: 'Nova publicação' });
    await pickAndSelect(media, 2);
    await userEvent.type(screen.getByLabelText('Legenda'), 'Domingo no parque');
    await userEvent.press(share());

    // O modal fecha depois do rascunho; a faixa acompanha o resto.
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio');
    });
    expect(await screen.findByText(PUBLISHED_MESSAGE)).toBeOnTheScreen();

    // HEIC → JPEG reduzido antes do upload: o rascunho declara o tipo e o tamanho exatos.
    expect(media.prepared.map((image) => image.mimeType)).toEqual(['image/heic', 'image/heic']);
    const draftBody = api.callsTo('POST /v1/posts/drafts')[0]?.body as {
      type: string;
      items: { mime: string; sizeBytes: number }[];
    };
    expect(draftBody.type).toBe('photo');
    expect(draftBody.items.map((item) => item.mime)).toEqual(['image/jpeg', 'image/jpeg']);
    // Um PUT por foto, na URL e com os cabeçalhos devolvidos (Content-Length = tamanho declarado).
    expect(media.uploads).toHaveLength(2);
    media.uploads.forEach((upload, position) => {
      expect(upload.url).toContain(`/incoming/${postId}/${String(position)}`);
      expect(upload.headers).toEqual({
        'Content-Type': 'image/jpeg',
        'Content-Length': String(draftBody.items[position]?.sizeBytes),
      });
    });
    expect(api.callsTo(`POST /v1/posts/${postId}/publish`)[0]?.body).toEqual({
      caption: 'Domingo no parque',
    });
    expect(api.callsTo(`GET /v1/posts/${postId}`).length).toBeGreaterThanOrEqual(3);
    // D9: o post publicado entra no topo do feed de fotos, e a faixa some.
    expect(screen.getByTestId(`post-${postId}`)).toBeOnTheScreen();
    expect(screen.queryByTestId('publishing-banners')).not.toBeOnTheScreen();
  });

  it('MID-10 (2.2 CA7): o worker falha → "Não foi possível publicar." e "Tentar de novo" cria outro rascunho', async () => {
    const media = createFakeMedia();
    const firstId = uuid();
    const secondId = uuid();
    let drafts = 0;
    const { api } = await renderApp({
      signedInAs: personalMe(),
      media,
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        photoFlow(fake, firstId, ['failed']);
        photoFlow(fake, secondId, ['published']);
        fake.on('POST /v1/posts/drafts', ({ body }) => {
          drafts += 1;
          const items = (body as { items: { sizeBytes: number }[] }).items;
          return {
            status: 201,
            body: draft(
              items.map((item) => item.sizeBytes),
              { postId: drafts === 1 ? firstId : secondId },
            ),
          };
        });
        fake.on(`DELETE /v1/posts/${firstId}`, { status: 204 });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Criar publicação' }));
    await screen.findByRole('header', { name: 'Nova publicação' });
    await pickAndSelect(media, 1);
    await userEvent.press(share());
    expect(await screen.findByText('Não foi possível publicar.')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText(PUBLISHED_MESSAGE)).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/posts/drafts')).toHaveLength(2);
    // O post que falhou sai do perfil antes de tentar de novo.
    expect(api.callsTo(`DELETE /v1/posts/${firstId}`)).toHaveLength(1);
    expect(media.uploads).toHaveLength(2);
  });

  it('MID-07/MID-08: PUT recusado e MEDIA_NOT_UPLOADED → "Tentar de novo" reenvia só as fotos que faltam', async () => {
    const media = createFakeMedia();
    const postId = uuid();
    let publishCalls = 0;
    const { api } = await renderApp({
      signedInAs: personalMe(),
      media,
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        photoFlow(fake, postId, ['published']);
        fake.on(`POST /v1/posts/${postId}/publish`, () => {
          publishCalls += 1;
          return publishCalls === 1
            ? {
                status: 409,
                body: {
                  code: 'MEDIA_NOT_UPLOADED',
                  message: 'Media not uploaded',
                  details: { positions: [1] },
                },
              }
            : {
                status: 200,
                body: photoPost({
                  id: postId,
                  isOwn: true,
                  status: 'processing',
                  publishedAt: null,
                }),
              };
        });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Criar publicação' }));
    await screen.findByRole('header', { name: 'Nova publicação' });
    await pickAndSelect(media, 2);
    await userEvent.press(share());
    expect(await screen.findByText('Não foi possível publicar.')).toBeOnTheScreen();
    expect(media.uploads).toHaveLength(2);
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText(PUBLISHED_MESSAGE)).toBeOnTheScreen();
    // Só a posição 1 voltou ao S3; o rascunho é o mesmo.
    expect(media.uploads).toHaveLength(3);
    expect(media.uploads[2]?.url).toContain(`/incoming/${postId}/1`);
    expect(api.callsTo('POST /v1/posts/drafts')).toHaveLength(1);
  });

  it('PUT que falha (rede) mostra a faixa de falha; ✕ descarta e apaga o rascunho', async () => {
    const media = createFakeMedia();
    const postId = uuid();
    media.failUploads(() => new NetworkError());
    jest.spyOn(Alert, 'alert').mockImplementation((_t, _m, buttons?: AlertButton[]) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
    const { api } = await renderApp({
      signedInAs: personalMe(),
      media,
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        photoFlow(fake, postId, ['published']);
        fake.on(`DELETE /v1/posts/${postId}`, { status: 204 });
      },
    });
    await userEvent.press(await screen.findByRole('button', { name: 'Criar publicação' }));
    await screen.findByRole('header', { name: 'Nova publicação' });
    await pickAndSelect(media, 1);
    await userEvent.press(share());
    expect(await screen.findByText('Não foi possível publicar.')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Descartar publicação' }));
    await waitFor(() => {
      expect(screen.queryByText('Não foi possível publicar.')).not.toBeOnTheScreen();
    });
    expect(api.callsTo(`DELETE /v1/posts/${postId}`)).toHaveLength(1);
  });

  it('2.1/2.2: o criador também publica; o público é "Para seus N seguidores"', async () => {
    await openCreate({ signedInAs: creatorMe() });
    expect(screen.getByText('Para seus 2.418 seguidores')).toBeOnTheScreen();
    await switchToText();
    expect(screen.getByText('Para seus 2.418 seguidores')).toBeOnTheScreen();
  });

  it('pessoa: "Para suas 4 conexões"', async () => {
    await openCreate();
    expect(screen.getByText('Para suas 4 conexões')).toBeOnTheScreen();
  });
});
