import { MAX_REEL_DURATION_S, MAX_VIDEO_BYTES, type Post } from '@sussurro/shared';
import { fireEvent, userEvent } from '@testing-library/react-native';
import { useNetworkState } from 'expo-network';
import { act, screen, waitFor, within } from 'expo-router/testing-library';
import { Alert, type AlertButton } from 'react-native';

import { SHARE_OFFLINE_MESSAGE } from './CreateScreen';
import { PUBLISHED_MESSAGE } from './PublishingProvider';
import { REEL_PROBLEM_MESSAGE } from './reel-selection';
import { NetworkError } from '../../lib/api/errors';
import { creatorMe, type FakeApi, personalMe, session } from '../../test-utils/fake-api';
import { createFakeMedia, type FakeMedia, pickedVideo } from '../../test-utils/fake-media';
import {
  AUTHORS,
  pendingVideo,
  reelDraft,
  reelPost,
  uuid,
  videoMedia,
} from '../../test-utils/post-fixtures';
import { renderApp } from '../../test-utils/render-app';
import { fakeVideo } from '../../test-utils/video-mock';

afterEach(() => {
  jest.restoreAllMocks();
  jest.mocked(useNetworkState).mockReturnValue({ isConnected: true, isInternetReachable: true });
});

beforeEach(() => {
  fakeVideo.reset();
});

const share = () => screen.getByRole('button', { name: 'Compartilhar' });

type Status = 'processing' | 'published' | 'failed';

/** O reel do autor (@helena) no estado pedido, como a API devolve. */
function ownReel(postId: string, status: Status, caption: string | null = null): Post {
  return reelPost({
    id: postId,
    isOwn: true,
    author: AUTHORS.helena,
    status,
    caption,
    publishedAt: status === 'published' ? '2026-10-29T12:00:00.000Z' : null,
    media: [status === 'published' ? videoMedia({ durationS: 42.5 }) : pendingVideo(status)],
  });
}

/**
 * Rascunho, publish e consulta de um reel. `statuses` é a sequência do `GET /posts/:id` (repete a
 * última). A aba Reels do perfil de @helena lista os reels publicados por aqui, no estado atual (o
 * dono vê `processing` e `failed`), até serem apagados.
 */
function reelFlow(fake: FakeApi, postIds: string[], statuses: Record<string, Status[]>) {
  let drafts = 0;
  const current = new Map<string, Status>();
  fake.on('GET /v1/users/helena/posts', ({ query }) => ({
    status: 200,
    body: {
      items:
        query.type === 'reel'
          ? [...current].reverse().map(([postId, status]) => ownReel(postId, status))
          : [],
      nextCursor: null,
    },
  }));
  fake.on('POST /v1/posts/drafts', ({ body }) => {
    const { video, poster } = body as {
      video: { sizeBytes: number; mime: 'video/mp4' | 'video/quicktime' };
      poster: { sizeBytes: number };
    };
    const postId = postIds[Math.min(drafts, postIds.length - 1)] ?? uuid();
    drafts += 1;
    return {
      status: 201,
      body: reelDraft({
        postId,
        videoSize: video.sizeBytes,
        videoMime: video.mime,
        posterSize: poster.sizeBytes,
      }),
    };
  });
  for (const postId of postIds) {
    const queue = [...(statuses[postId] ?? ['published'])];
    fake.on(`POST /v1/posts/${postId}/publish`, ({ body }) => {
      current.set(postId, 'processing');
      return {
        status: 200,
        body: ownReel(postId, 'processing', (body as { caption?: string }).caption ?? null),
      };
    });
    fake.on(`GET /v1/posts/${postId}`, () => {
      const status = queue.length > 1 ? (queue.shift() ?? 'published') : (queue[0] ?? 'published');
      current.set(postId, status);
      return { status: 200, body: ownReel(postId, status) };
    });
    fake.on(`DELETE /v1/posts/${postId}`, () => {
      current.delete(postId);
      return { status: 204 };
    });
  }
}

async function openReelMode(options: Parameters<typeof renderApp>[0] = {}) {
  const result = await renderApp({
    signedInAs: personalMe(),
    initialUrl: '/pessoal/perfil',
    ...options,
  });
  await userEvent.press(await screen.findByRole('button', { name: 'Criar publicação' }));
  await screen.findByRole('header', { name: 'Nova publicação' });
  await userEvent.press(screen.getByRole('tab', { name: 'Reel' }));
  expect(screen.getByRole('tab', { name: 'Reel' })).toBeSelected();
  return result;
}

async function pickVideo(media: FakeMedia, video = pickedVideo()) {
  media.queueVideo(video);
  await userEvent.press(screen.getByRole('button', { name: 'Escolher vídeo do aparelho' }));
  return video;
}

/** Responde ao Alert apertando o botão destrutivo (Descartar, Excluir). */
function confirmAlerts() {
  return jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons?: AlertButton[]) => {
      buttons?.find((button) => button.style === 'destructive')?.onPress?.();
    });
}

describe('Criar: modo REEL (história 5.3)', () => {
  it('5.3 CA2/MID-14: acima de 90 s ou de 200 MB o vídeo entra esmaecido ("Até 90 s"/"Até 200 MB") e não pode ser escolhido', async () => {
    const media = createFakeMedia();
    const { api } = await openReelMode({ media });
    expect(share()).toBeDisabled();

    await pickVideo(media, pickedVideo({ durationS: MAX_REEL_DURATION_S + 1 }));
    expect(await screen.findByText(REEL_PROBLEM_MESSAGE.too_long)).toBeOnTheScreen();
    expect(screen.getByTestId('reel-picker-item-0-limite')).toHaveTextContent('Até 90 s');
    // Tocar no vídeo longo não o escolhe: explica de novo e o Compartilhar segue desabilitado.
    await userEvent.press(
      screen.getByRole('button', { name: /^Vídeo 1, 1 minuto e 31 segundos, até 90 s/ }),
    );
    expect(screen.getByRole('button', { name: /^Vídeo 1/ })).not.toBeSelected();
    expect(share()).toBeDisabled();

    // 90,01 s também passa do limite (a mesma regra da API: 91 s ou 90,01 s → 400).
    await pickVideo(media, pickedVideo({ durationS: 90.01 }));
    expect(screen.getByTestId('reel-picker-item-1-limite')).toHaveTextContent('Até 90 s');

    // 200 MB + 1 byte (o Toast deste fica na fila atrás do anterior).
    await pickVideo(media, pickedVideo({ sizeBytes: MAX_VIDEO_BYTES + 1 }));
    expect(await screen.findByTestId('reel-picker-item-2-limite')).toHaveTextContent('Até 200 MB');
    expect(share()).toBeDisabled();

    // No limite exato (90 s e 200 MB) entra marcado.
    await pickVideo(
      media,
      pickedVideo({ durationS: MAX_REEL_DURATION_S, sizeBytes: MAX_VIDEO_BYTES }),
    );
    expect(screen.queryByTestId('reel-picker-item-3-limite')).not.toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: /^Vídeo 4, 1 minuto e 30 segundos, selecionado/ }),
    ).toBeSelected();
    expect(share()).toBeEnabled();
    expect(api.callsTo('POST /v1/posts/drafts')).toHaveLength(0);
  });

  it('MID-14: o .mov do iPhone é aceito; outro tipo (WebM) entra esmaecido com "MP4 ou MOV"', async () => {
    const media = createFakeMedia();
    await openReelMode({ media });
    await pickVideo(media, pickedVideo({ mime: null, uri: 'file:///cache/VID.webm' }));
    expect(await screen.findByText(REEL_PROBLEM_MESSAGE.unsupported)).toBeOnTheScreen();
    expect(screen.getByTestId('reel-picker-item-0-limite')).toHaveTextContent('MP4 ou MOV');
    const mov = await pickVideo(media, pickedVideo({ mime: 'video/quicktime' }));
    expect(
      screen.getByRole('button', { name: /^Vídeo 2, 43 segundos, selecionado/ }),
    ).toBeSelected();
    // A prévia 9:16 mostra a duração e abre o vídeo local no visualizador (sem curtir nem comentar).
    expect(screen.getByText('0:43 · toque para assistir')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Assistir à prévia do reel' }));
    expect(fakeVideo.last().source).toEqual({ uri: mov.uri });
    expect(screen.queryByRole('button', { name: 'Curtir' })).not.toBeOnTheScreen();
  });

  it('5.3 CA1/MID-09: rascunho → PUT do vídeo e da capa com os cabeçalhos assinados → publish → "Processando o reel…" → published', async () => {
    const media = createFakeMedia();
    const postId = uuid();
    let ready = false;
    const { api } = await openReelMode({
      media,
      configure: (fake) => {
        reelFlow(fake, [postId], {});
        fake.on(`GET /v1/posts/${postId}`, () => ({
          status: 200,
          body: ownReel(postId, ready ? 'published' : 'processing'),
        }));
      },
    });
    const video = await pickVideo(media);
    await userEvent.type(screen.getByLabelText('Legenda'), 'Pão de quinta');
    await userEvent.press(share());

    // O modal fecha depois do rascunho; a faixa acompanha o envio e o processamento.
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/perfil');
    });
    expect(await screen.findByText('Processando o reel…')).toBeOnTheScreen();
    // Enquanto processa, o autor vê o tile "Processando" na aba Reels do próprio perfil.
    await userEvent.press(screen.getByRole('tab', { name: 'Reels' }));
    expect(await screen.findByRole('button', { name: 'Reel processando' })).toBeOnTheScreen();

    ready = true;
    expect(await screen.findByText(PUBLISHED_MESSAGE, {}, { timeout: 3000 })).toBeOnTheScreen();
    expect(
      await screen.findByRole('button', { name: 'Reel de @helena, 43 segundos' }),
    ).toBeOnTheScreen();
    expect(screen.queryByTestId('publishing-banners')).not.toBeOnTheScreen();

    // O rascunho leva o tipo, o tamanho exato e a duração do seletor, e o tamanho da capa (D10).
    const poster = media.posters.length;
    expect(poster).toBe(1);
    expect(api.callsTo('POST /v1/posts/drafts')[0]?.body).toEqual({
      type: 'reel',
      video: { mime: 'video/quicktime', sizeBytes: video.sizeBytes, durationS: 42.5 },
      poster: { mime: 'image/jpeg', sizeBytes: 200_001 },
    });
    // Um PUT do vídeo (direto do arquivo) e um da capa, nas URLs e com os cabeçalhos devolvidos.
    expect(media.videoUploads).toHaveLength(1);
    expect(media.videoUploads[0]?.url).toContain(`/incoming/${postId}/video`);
    expect(media.videoUploads[0]?.headers).toEqual({
      'Content-Type': 'video/quicktime',
      'Content-Length': String(video.sizeBytes),
    });
    expect(media.videoUploads[0]?.video.uri).toBe(video.uri);
    expect(media.uploads).toHaveLength(1);
    expect(media.uploads[0]?.url).toContain(`/incoming/${postId}/poster`);
    expect(media.uploads[0]?.headers).toEqual({
      'Content-Type': 'image/jpeg',
      'Content-Length': '200001',
    });
    expect(api.callsTo(`POST /v1/posts/${postId}/publish`)[0]?.body).toEqual({
      caption: 'Pão de quinta',
    });
    expect(api.callsTo(`GET /v1/posts/${postId}`).length).toBeGreaterThanOrEqual(2);
  });

  it('MID-10/5.6: o worker falha → "Não foi possível publicar." e o tile "Falhou"; "Tentar de novo" apaga o reel e recria com o mesmo arquivo', async () => {
    const media = createFakeMedia();
    const firstId = uuid();
    const secondId = uuid();
    const { api } = await openReelMode({
      media,
      configure: (fake) => {
        reelFlow(fake, [firstId, secondId], { [firstId]: ['failed'], [secondId]: ['published'] });
      },
    });
    const video = await pickVideo(media);
    await userEvent.press(share());
    expect(await screen.findByText('Não foi possível publicar.')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('tab', { name: 'Reels' }));
    expect(await screen.findByText('Falhou')).toBeOnTheScreen();

    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText(PUBLISHED_MESSAGE)).toBeOnTheScreen();
    // O reel que falhou sai do servidor e do perfil; um rascunho novo leva o mesmo vídeo.
    expect(api.callsTo(`DELETE /v1/posts/${firstId}`)).toHaveLength(1);
    expect(screen.queryByText('Falhou')).not.toBeOnTheScreen();
    expect(api.callsTo('POST /v1/posts/drafts')).toHaveLength(2);
    expect(media.videoUploads.map((upload) => upload.video.uri)).toEqual([video.uri, video.uri]);
    expect(media.videoUploads[1]?.url).toContain(`/incoming/${secondId}/video`);
    // A capa é gerada de novo do mesmo arquivo (e confere que ele ainda está no aparelho).
    expect(media.posters).toHaveLength(2);
  });

  it('5.6: o vídeo não está mais no aparelho → "Escolher o vídeo de novo" ou descartar; escolher outro recria o reel', async () => {
    const media = createFakeMedia();
    const firstId = uuid();
    const secondId = uuid();
    const { api } = await openReelMode({
      media,
      configure: (fake) => {
        reelFlow(fake, [firstId, secondId], { [firstId]: ['failed'], [secondId]: ['published'] });
      },
    });
    const video = await pickVideo(media);
    await userEvent.press(share());
    expect(await screen.findByText('Não foi possível publicar.')).toBeOnTheScreen();

    media.loseVideo(video);
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('O vídeo não está mais no aparelho.')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).not.toBeOnTheScreen();
    // Nada foi apagado nem recriado ainda.
    expect(api.callsTo(`DELETE /v1/posts/${firstId}`)).toHaveLength(0);
    expect(api.callsTo('POST /v1/posts/drafts')).toHaveLength(1);

    const other = pickedVideo({ sizeBytes: 12_345_678 });
    media.queueVideo(other);
    await userEvent.press(screen.getByRole('button', { name: 'Escolher o vídeo de novo' }));
    expect(await screen.findByText(PUBLISHED_MESSAGE)).toBeOnTheScreen();
    expect(api.callsTo(`DELETE /v1/posts/${firstId}`)).toHaveLength(1);
    const second = api.callsTo('POST /v1/posts/drafts')[1]?.body as {
      video: { sizeBytes: number };
    };
    expect(second.video.sizeBytes).toBe(12_345_678);
    expect(media.videoUploads.at(-1)?.video.uri).toBe(other.uri);
  });

  it('5.6: com o vídeo indisponível, ✕ descarta e apaga o reel que falhou', async () => {
    const media = createFakeMedia();
    const postId = uuid();
    confirmAlerts();
    const { api } = await openReelMode({
      media,
      configure: (fake) => {
        reelFlow(fake, [postId], { [postId]: ['failed'] });
      },
    });
    const video = await pickVideo(media);
    await userEvent.press(share());
    expect(await screen.findByText('Não foi possível publicar.')).toBeOnTheScreen();
    media.loseVideo(video);
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    await screen.findByText('O vídeo não está mais no aparelho.');
    await userEvent.press(screen.getByRole('button', { name: 'Descartar publicação' }));
    await waitFor(() => {
      expect(api.callsTo(`DELETE /v1/posts/${postId}`)).toHaveLength(1);
    });
    expect(screen.queryByText('O vídeo não está mais no aparelho.')).not.toBeOnTheScreen();
  });

  it('MID-08 (reel): 409 MEDIA_NOT_UPLOADED → "Tentar de novo" reenvia só o que falta (o vídeo; depois só a capa)', async () => {
    const media = createFakeMedia();
    const postId = uuid();
    let publishCalls = 0;
    const { api } = await openReelMode({
      media,
      configure: (fake) => {
        reelFlow(fake, [postId], { [postId]: ['published'] });
        fake.on(`POST /v1/posts/${postId}/publish`, () => {
          publishCalls += 1;
          const missing =
            publishCalls === 1
              ? { positions: [0], poster: false }
              : publishCalls === 2
                ? { positions: [], poster: true }
                : null;
          return missing === null
            ? { status: 200, body: ownReel(postId, 'processing') }
            : {
                status: 409,
                body: {
                  code: 'MEDIA_NOT_UPLOADED',
                  message: 'O vídeo ou a capa não foram enviados',
                  details: missing,
                },
              };
        });
      },
    });
    await pickVideo(media);
    await userEvent.press(share());
    expect(await screen.findByText('Não foi possível publicar.')).toBeOnTheScreen();
    expect(media.videoUploads).toHaveLength(1);
    expect(media.uploads).toHaveLength(1);

    // Faltou o vídeo: só ele volta ao S3.
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    await waitFor(() => {
      expect(publishCalls).toBe(2);
    });
    expect(await screen.findByText('Não foi possível publicar.')).toBeOnTheScreen();
    expect(media.videoUploads).toHaveLength(2);
    expect(media.uploads).toHaveLength(1);

    // Faltou a capa: só ela.
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText(PUBLISHED_MESSAGE)).toBeOnTheScreen();
    expect(media.videoUploads).toHaveLength(2);
    expect(media.uploads).toHaveLength(2);
    expect(media.uploads[1]?.url).toContain(`/incoming/${postId}/poster`);
    // Sempre o mesmo rascunho.
    expect(api.callsTo('POST /v1/posts/drafts')).toHaveLength(1);
  });

  it('rede: o PUT do vídeo falha → "Tentar de novo" retoma no mesmo rascunho', async () => {
    const media = createFakeMedia();
    const postId = uuid();
    let failures = 1;
    media.failVideoUploads(() => {
      if (failures === 0) return null;
      failures -= 1;
      return new NetworkError();
    });
    const { api } = await openReelMode({
      media,
      configure: (fake) => {
        reelFlow(fake, [postId], { [postId]: ['published'] });
      },
    });
    await pickVideo(media);
    await userEvent.press(share());
    expect(await screen.findByText('Não foi possível publicar.')).toBeOnTheScreen();
    expect(api.callsTo(`POST /v1/posts/${postId}/publish`)).toHaveLength(0);
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText(PUBLISHED_MESSAGE)).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/posts/drafts')).toHaveLength(1);
    expect(media.videoUploads).toHaveLength(1);
  });

  it('429 (10 rascunhos de reel por hora): Toast e o modal continua aberto', async () => {
    const media = createFakeMedia();
    const { api } = await openReelMode({
      media,
      configure: (fake) => {
        fake.on('POST /v1/posts/drafts', {
          status: 429,
          body: { code: 'RATE_LIMITED', message: 'Too many requests' },
        });
      },
    });
    await pickVideo(media);
    await userEvent.press(share());
    expect(
      await screen.findByText('Muitas tentativas. Espere um pouco e tente de novo.'),
    ).toBeOnTheScreen();
    expect(screen).toHavePathname('/criar');
    expect(api.callsTo('POST /v1/posts/drafts')).toHaveLength(1);
    expect(media.videoUploads).toHaveLength(0);
  });

  it('2.2 CA9 (reel): offline no Compartilhar mostra o Toast, não cria rascunho e mantém o modal', async () => {
    const media = createFakeMedia();
    jest
      .mocked(useNetworkState)
      .mockReturnValue({ isConnected: false, isInternetReachable: false });
    const { api } = await openReelMode({ media });
    await pickVideo(media);
    await userEvent.press(share());
    expect(await screen.findByText(SHARE_OFFLINE_MESSAGE)).toBeOnTheScreen();
    expect(screen).toHavePathname('/criar');
    expect(api.callsTo('POST /v1/posts/drafts')).toHaveLength(0);
  });

  it('X.3: EMAIL_NOT_VERIFIED no rascunho do reel mostra "Confirme seu e-mail…"', async () => {
    const media = createFakeMedia();
    await openReelMode({
      media,
      signedInAs: personalMe({ emailVerified: false }),
      configure: (fake) => {
        fake.on('POST /v1/posts/drafts', {
          status: 403,
          body: { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' },
        });
      },
    });
    await pickVideo(media);
    await userEvent.press(share());
    const toast = await screen.findByTestId('toast');
    expect(
      within(toast).getByText('Confirme seu e-mail para publicar e comentar.'),
    ).toBeOnTheScreen();
  });

  it('o criador também publica reels ("Para seus N seguidores")', async () => {
    const media = createFakeMedia();
    // `/criar?modo=reel` abre direto no REEL (o "Nova publicação" da aba Reels vazia do perfil).
    await renderApp({ signedInAs: creatorMe(), initialUrl: '/criar?modo=reel', media });
    await screen.findByRole('header', { name: 'Nova publicação' });
    expect(screen.getByRole('tab', { name: 'Reel' })).toBeSelected();
    expect(screen.getByText('Para seus 2.418 seguidores')).toBeOnTheScreen();
    await pickVideo(media);
    expect(share()).toBeEnabled();
  });
});

describe('tile "Falhou" no próprio perfil (história 5.6)', () => {
  it('5.6 CA1: reel que falhou em outra sessão: "Tentar de novo" pede o vídeo de novo e recria com a mesma legenda', async () => {
    const media = createFakeMedia();
    const failedId = uuid();
    const newId = uuid();
    const failed = ownReel(failedId, 'failed', 'Pão de quinta');
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
      media,
      configure: (fake) => {
        reelFlow(fake, [newId], { [newId]: ['published'] });
        fake.on(`DELETE /v1/posts/${failedId}`, { status: 204 });
        fake.on('GET /v1/users/helena/posts', ({ query }) => ({
          status: 200,
          body: { items: query.type === 'reel' ? [failed] : [], nextCursor: null },
        }));
      },
    });
    await userEvent.press(await screen.findByRole('tab', { name: 'Reels' }));
    await userEvent.press(await screen.findByRole('button', { name: 'Reel não publicado' }));
    const menu = within(screen.getByTestId('reel-falhou-menu'));
    expect(menu.getByText('Não foi possível publicar este reel.')).toBeOnTheScreen();
    expect(
      menu.getAllByRole('button').map((node) => String(node.props.accessibilityLabel)),
    ).toEqual(['Tentar de novo', 'Excluir', 'Cancelar']);
    const video = pickedVideo();
    media.queueVideo(video);
    await userEvent.press(menu.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText(PUBLISHED_MESSAGE)).toBeOnTheScreen();
    expect(api.callsTo(`DELETE /v1/posts/${failedId}`)).toHaveLength(1);
    expect(api.callsTo(`POST /v1/posts/${newId}/publish`)[0]?.body).toEqual({
      caption: 'Pão de quinta',
    });
    expect(media.videoUploads[0]?.video.uri).toBe(video.uri);
    expect(screen.queryByText('Falhou')).not.toBeOnTheScreen();
  });

  it('5.6 CA1: "Excluir" confirma e apaga o reel que falhou', async () => {
    const failedId = uuid();
    const alert = confirmAlerts();
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
      configure: (fake) => {
        fake.on(`DELETE /v1/posts/${failedId}`, { status: 204 });
        fake.on('GET /v1/users/helena/posts', ({ query }) => ({
          status: 200,
          body: {
            items: query.type === 'reel' ? [ownReel(failedId, 'failed')] : [],
            nextCursor: null,
          },
        }));
      },
    });
    await userEvent.press(await screen.findByRole('tab', { name: 'Reels' }));
    await userEvent.press(await screen.findByRole('button', { name: 'Reel não publicado' }));
    await userEvent.press(
      within(screen.getByTestId('reel-falhou-menu')).getByRole('button', { name: 'Excluir' }),
    );
    expect(alert).toHaveBeenCalledWith(
      'Excluir publicação?',
      'Não dá para desfazer.',
      expect.any(Array),
    );
    await waitFor(() => {
      expect(api.callsTo(`DELETE /v1/posts/${failedId}`)).toHaveLength(1);
    });
    await waitFor(() => {
      expect(screen.queryByText('Falhou')).not.toBeOnTheScreen();
    });
  });
});

describe('Criar: a troca de conta no meio do envio (BAIXO do seguranca)', () => {
  const MARINA = personalMe({
    id: '01a189e0-af57-7000-85fe-2054e618feb1',
    email: 'marina@example.com',
    handle: 'marina',
    name: 'Marina Costa',
  });

  async function advance(ms: number) {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }

  /** Helena sai pelo Perfil e Marina entra em Entrar (a API falsa devolve a sessão dela). */
  async function switchToMarina(api: FakeApi) {
    await userEvent.press(screen.getByRole('button', { name: 'Sair da conta' }));
    api.on('POST /v1/auth/login', () => ({ status: 200, body: session(MARINA) }));
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    await fireEvent.changeText(screen.getByLabelText('E-mail'), MARINA.email);
    await fireEvent.changeText(screen.getByLabelText('Senha'), 'cafe-coado-42');
    await userEvent.press(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByTestId('tela-inicio')).toBeOnTheScreen();
  }

  it('MID-15 (AUTH-15; BAIXO do seguranca): Helena sai com o vídeo do reel subindo e entra de novo → o envio antigo foi descartado: a faixa não volta no Perfil e nada mais sai dele', async () => {
    const media = createFakeMedia();
    let finishUpload: () => void = () => undefined;
    const uploading = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    const uploadVideo = media.ports.uploadVideo;
    media.ports.uploadVideo = async (...args) => {
      await uploading;
      return uploadVideo(...args);
    };
    const postId = uuid();
    const helena = personalMe();
    confirmAlerts();
    const { api } = await openReelMode({
      media,
      configure: (fake) => {
        reelFlow(fake, [postId], {});
        fake.on('POST /v1/auth/logout', { status: 204 });
      },
    });
    await pickVideo(media);
    await userEvent.press(share());
    expect(await screen.findByTestId('publishing-banners')).toBeOnTheScreen();

    await userEvent.press(screen.getByRole('button', { name: 'Sair da conta' }));
    api.on('POST /v1/auth/login', () => ({ status: 200, body: session(helena) }));
    await waitFor(() => {
      expect(screen).toHavePathname('/entrar');
    });
    await fireEvent.changeText(screen.getByLabelText('E-mail'), helena.email);
    await fireEvent.changeText(screen.getByLabelText('Senha'), 'cafe-coado-42');
    await userEvent.press(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByTestId('tela-inicio')).toBeOnTheScreen();
    finishUpload();
    await advance(30_000);
    await userEvent.press(screen.getByRole('tab', { name: 'Perfil' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/perfil');
    });
    // Sem o `finish` na troca, a faixa "Enviando" do envio descartado voltaria, parada para sempre.
    expect(screen.queryByTestId('publishing-banners')).not.toBeOnTheScreen();
    expect(media.uploads).toHaveLength(0);
    expect(api.callsTo(`POST /v1/posts/${postId}/publish`)).toHaveLength(0);
    expect(screen.queryByText(PUBLISHED_MESSAGE)).not.toBeOnTheScreen();
  });

  it('MID-15 (AUTH-15; BAIXO do seguranca): Helena sai com o vídeo do reel subindo e Marina entra → o envio de Helena para: sem a capa, sem o publish com o token de Marina, sem Toast e sem faixa', async () => {
    const media = createFakeMedia();
    // O PUT do vídeo só termina quando o teste mandar.
    let finishUpload: () => void = () => undefined;
    const uploading = new Promise<void>((resolve) => {
      finishUpload = resolve;
    });
    const uploadVideo = media.ports.uploadVideo;
    media.ports.uploadVideo = async (...args) => {
      await uploading;
      return uploadVideo(...args);
    };
    const postId = uuid();
    confirmAlerts();
    const { api } = await openReelMode({
      media,
      configure: (fake) => {
        reelFlow(fake, [postId], {});
        fake.on('POST /v1/auth/logout', { status: 204 });
      },
    });
    await pickVideo(media);
    await userEvent.press(share());
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/perfil');
    });
    expect(await screen.findByTestId('publishing-banners')).toBeOnTheScreen();

    await switchToMarina(api);
    finishUpload();
    await advance(30_000);
    // Nada do envio de Helena sai com a sessão de Marina.
    expect(media.uploads).toHaveLength(0);
    expect(api.callsTo(`POST /v1/posts/${postId}/publish`)).toHaveLength(0);
    expect(api.callsTo(`GET /v1/posts/${postId}`)).toHaveLength(0);
    expect(screen.queryByText(PUBLISHED_MESSAGE)).not.toBeOnTheScreen();
    expect(screen.queryByTestId('publishing-banners')).not.toBeOnTheScreen();
  });

  it('MID-15 (AUTH-15; BAIXO do seguranca): Helena sai com o reel processando e Marina entra → a consulta do post para (nenhum GET com o token de Marina), sem Toast e sem faixa', async () => {
    const media = createFakeMedia();
    const postId = uuid();
    confirmAlerts();
    const { api } = await openReelMode({
      media,
      configure: (fake) => {
        reelFlow(fake, [postId], { [postId]: ['processing'] });
        fake.on('POST /v1/auth/logout', { status: 204 });
      },
    });
    await pickVideo(media);
    await userEvent.press(share());
    expect(await screen.findByText('Processando o reel…')).toBeOnTheScreen();
    await waitFor(() => {
      expect(api.callsTo(`GET /v1/posts/${postId}`).length).toBeGreaterThanOrEqual(1);
    });

    await switchToMarina(api);
    const polls = api.callsTo(`GET /v1/posts/${postId}`).length;
    await advance(60_000);
    // Sem o descarte, a consulta seguiria a cada até 10 s, com o token de Marina.
    expect(api.callsTo(`GET /v1/posts/${postId}`)).toHaveLength(polls);
    expect(screen.queryByText(PUBLISHED_MESSAGE)).not.toBeOnTheScreen();
    expect(screen.queryByTestId('publishing-banners')).not.toBeOnTheScreen();
  });

  it('MID-15 (AUTH-15; BAIXO do seguranca): no "Tentar de novo" com a URL do vídeo vencida (rascunho novo, sem reel a trocar), Helena sai com a capa sendo gerada e Marina entra → nenhum rascunho sai com o token de Marina, sem envio e sem faixa', async () => {
    const media = createFakeMedia();
    // O PUT do vídeo falha uma vez; depois, a URL vence e o "Tentar de novo" pede um rascunho novo,
    // que começa pela capa (`newDraft`). A capa só termina quando o teste mandar.
    let failures = 1;
    media.failVideoUploads(() => {
      if (failures === 0) return null;
      failures -= 1;
      return new NetworkError();
    });
    let holdPoster = false;
    let finishPoster: () => void = () => undefined;
    const posterGate = new Promise<void>((resolve) => {
      finishPoster = resolve;
    });
    const createPoster = media.ports.createPoster;
    media.ports.createPoster = async (video) => {
      if (holdPoster) await posterGate;
      return createPoster(video);
    };
    const postId = uuid();
    confirmAlerts();
    const { api } = await openReelMode({
      media,
      configure: (fake) => {
        reelFlow(fake, [postId], {});
        fake.on('POST /v1/auth/logout', { status: 204 });
        // As URLs do rascunho valem 60 s (a margem do app é de 30 s).
        fake.on('POST /v1/posts/drafts', ({ body }) => {
          const { video, poster } = body as {
            video: { sizeBytes: number; mime: 'video/mp4' | 'video/quicktime' };
            poster: { sizeBytes: number };
          };
          return {
            status: 201,
            body: reelDraft({
              postId,
              videoSize: video.sizeBytes,
              videoMime: video.mime,
              posterSize: poster.sizeBytes,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            }),
          };
        });
      },
    });
    await pickVideo(media);
    await userEvent.press(share());
    expect(await screen.findByText('Não foi possível publicar.')).toBeOnTheScreen();
    expect(api.callsTo('POST /v1/posts/drafts')).toHaveLength(1);
    // A URL do vídeo vence (menos de 30 s de folga): o "Tentar de novo" recria o rascunho.
    await advance(31_000);
    holdPoster = true;
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    await advance(0);
    expect(media.posters).toHaveLength(1);

    await switchToMarina(api);
    finishPoster();
    await advance(30_000);
    // Sem o `stopped()` depois da capa, o rascunho do reel de Helena seria criado na conta de Marina.
    expect(api.callsTo('POST /v1/posts/drafts')).toHaveLength(1);
    expect(media.videoUploads).toHaveLength(0);
    expect(api.callsTo(`POST /v1/posts/${postId}/publish`)).toHaveLength(0);
    expect(screen.queryByText(PUBLISHED_MESSAGE)).not.toBeOnTheScreen();
    expect(screen.queryByTestId('publishing-banners')).not.toBeOnTheScreen();
  });

  it('MID-15 (AUTH-15; BAIXO do seguranca): no "Tentar de novo" de um reel que falhou, Helena sai durante a exclusão do reel antigo e Marina entra → o rascunho novo não sai com o token de Marina', async () => {
    const media = createFakeMedia();
    const failedId = uuid();
    const newId = uuid();
    let releaseDelete: () => void = () => undefined;
    confirmAlerts();
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: '/pessoal/perfil',
      media,
      configure: (fake) => {
        reelFlow(fake, [newId], { [newId]: ['published'] });
        fake.on('POST /v1/auth/logout', { status: 204 });
        // A exclusão do reel que falhou só responde quando o teste mandar.
        fake.on(
          `DELETE /v1/posts/${failedId}`,
          () =>
            new Promise((resolve) => {
              releaseDelete = () => {
                resolve({ status: 204 });
              };
            }),
        );
        fake.on('GET /v1/users/helena/posts', ({ query }) => ({
          status: 200,
          body: {
            items: query.type === 'reel' ? [ownReel(failedId, 'failed', 'Pão de quinta')] : [],
            nextCursor: null,
          },
        }));
      },
    });
    await userEvent.press(await screen.findByRole('tab', { name: 'Reels' }));
    await userEvent.press(await screen.findByRole('button', { name: 'Reel não publicado' }));
    media.queueVideo(pickedVideo());
    await userEvent.press(
      within(screen.getByTestId('reel-falhou-menu')).getByRole('button', {
        name: 'Tentar de novo',
      }),
    );
    await waitFor(() => {
      expect(api.callsTo(`DELETE /v1/posts/${failedId}`)).toHaveLength(1);
    });

    await switchToMarina(api);
    releaseDelete();
    await advance(30_000);
    // Sem o `stopped()` depois da exclusão, o rascunho novo seria criado na conta de Marina.
    expect(api.callsTo('POST /v1/posts/drafts')).toHaveLength(0);
    expect(media.videoUploads).toHaveLength(0);
    expect(screen.queryByText(PUBLISHED_MESSAGE)).not.toBeOnTheScreen();
    expect(screen.queryByTestId('publishing-banners')).not.toBeOnTheScreen();
  });
});
