import { act, userEvent } from '@testing-library/react-native';
import { router } from 'expo-router';
import { screen, waitFor, within } from 'expo-router/testing-library';

import {
  NOTIFICATIONS_EMPTY_TEXT,
  NOTIFICATIONS_EMPTY_TITLE,
  NOTIFICATIONS_END,
  NOTIFICATIONS_ERROR_TITLE,
} from './NotificationsScreen';
import { creatorMe, type FakeApi, personalMe } from '../../test-utils/fake-api';
import {
  actor,
  commented,
  connected,
  daysAgo,
  followers,
  liked,
  minutesAgo,
  notificationsPage,
  notifiedPost,
  replied,
} from '../../test-utils/notification-fixtures';
import { reelPost, uuid } from '../../test-utils/post-fixtures';
import { scrollListToEnd } from '../../test-utils/relation-fixtures';
import { renderApp } from '../../test-utils/render-app';
import { fakeVideo } from '../../test-utils/video-mock';

const PERSONAL = '/pessoal/inicio/notificacoes';
const CREATOR = '/criador/notificacoes';

beforeEach(() => {
  fakeVideo.reset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

/** Lista e contador de não lidas; o `POST /read` devolve 0. */
function notificationsApi(
  fake: FakeApi,
  items: Parameters<typeof notificationsPage>[0],
  unread = 0,
) {
  fake.on('GET /v1/notifications', { status: 200, body: notificationsPage(items) });
  fake.on('GET /v1/notifications/unread-count', { status: 200, body: { count: unread } });
  fake.on('POST /v1/notifications/read', { status: 200, body: { count: 0 } });
}

async function refreshList() {
  const list = screen.getByTestId('notificacoes-lista');
  await act(async () => {
    (list.props.refreshControl as { props: { onRefresh: () => void } }).props.onRefresh();
    await Promise.resolve();
  });
}

describe('Notificações da pessoa (p09, 6.1)', () => {
  it('6.1 CA1/NOT-03/A-35: "Hoje", "Esta semana" e "Anteriores" pelo fuso do aparelho, com os textos e o fim', async () => {
    // Relógio fixo ao meio-dia (no fuso do aparelho, qualquer que seja): com a hora real, entre
    // 00:00 e 00:20 o "há 20 minutos" caía no dia anterior e o "Hoje" sumia. Só o `Date` é falso;
    // os timers continuam reais, para o `findBy`/`waitFor`.
    jest.useFakeTimers({
      now: new Date(2026, 10, 18, 12, 0, 0),
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
    try {
      const today = liked({ updatedAt: minutesAgo(20) });
      const comment = commented({ updatedAt: minutesAgo(60) });
      const reply = replied({ updatedAt: minutesAgo(180) });
      const week = liked({
        actor: actor({ handle: 'juprado', name: 'Juliana Prado' }),
        post: notifiedPost({ type: 'text', thumbUrl: null }),
        updatedAt: daysAgo(2),
        read: true,
      });
      const older = connected({ updatedAt: daysAgo(10), read: true });
      await renderApp({
        signedInAs: personalMe(),
        initialUrl: PERSONAL,
        configure: (fake) => {
          notificationsApi(fake, [today, comment, reply, week, older], 3);
        },
      });
      expect(await screen.findByRole('header', { name: 'Hoje' })).toBeOnTheScreen();
      expect(screen.getByRole('header', { name: 'Esta semana' })).toBeOnTheScreen();
      expect(screen.getByRole('header', { name: 'Anteriores' })).toBeOnTheScreen();
      expect(
        screen.getByLabelText('marinac curtiu sua foto. há 20 minutos, nova'),
      ).toBeOnTheScreen();
      expect(screen.getByText('“Que luz bonita!”')).toBeOnTheScreen();
      expect(screen.getByText(' comentou na sua foto: ')).toBeOnTheScreen();
      expect(screen.getByText(' respondeu seu comentário: ')).toBeOnTheScreen();
      expect(screen.getByText(' curtiu seu texto.')).toBeOnTheScreen();
      expect(screen.getByText(' estão conectados.')).toBeOnTheScreen();
      // Foto com miniatura; texto sem miniatura.
      expect(screen.getByTestId(`notificacao-${today.id}-thumb`)).toBeOnTheScreen();
      expect(screen.queryByTestId(`notificacao-${week.id}-thumb`)).not.toBeOnTheScreen();
      // Não lidas com o ponto; lidas sem.
      expect(screen.getByTestId(`notificacao-${today.id}-unread`)).toBeOnTheScreen();
      expect(screen.queryByTestId(`notificacao-${week.id}-unread`)).not.toBeOnTheScreen();
      expect(screen.getByText(NOTIFICATIONS_END)).toBeOnTheScreen();
      // Empilhada no Início, com a tab bar e o Início ativo (D-UX19).
      expect(screen.getByRole('tab', { name: 'Início' })).toBeSelected();
      expect(screen.getByRole('header', { name: 'Notificações' })).toBeOnTheScreen();
    } finally {
      jest.useRealTimers();
    }
  });

  it('6.2 CA1/NOT-06: o ponto azul do coração some ao abrir; o POST /read leva o updatedAt da primeira', async () => {
    const first = liked({ updatedAt: minutesAgo(5) });
    const second = commented({ updatedAt: minutesAgo(50) });
    const { api } = await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        notificationsApi(fake, [first, second], 2);
      },
    });
    const heart = await screen.findByRole('button', { name: 'Notificações, há novidades' });
    expect(screen.getByTestId('coracao-dot')).toBeOnTheScreen();
    await userEvent.press(heart);
    await screen.findByTestId(`notificacao-${first.id}`);
    await waitFor(() => {
      expect(api.callsTo('POST /v1/notifications/read')).toHaveLength(1);
    });
    expect(api.callsTo('POST /v1/notifications/read')[0]?.body).toEqual({
      upTo: first.updatedAt,
    });
    await userEvent.press(screen.getByRole('button', { name: 'Voltar' }));
    expect(await screen.findByRole('button', { name: 'Notificações' })).toBeOnTheScreen();
    expect(screen.queryByTestId('coracao-dot')).not.toBeOnTheScreen();
  });

  it('6.2: tudo lido e sem não lidas: não chama o POST /read', async () => {
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: PERSONAL,
      configure: (fake) => {
        notificationsApi(fake, [liked({ read: true })], 0);
      },
    });
    await screen.findByText(NOTIFICATIONS_END);
    expect(api.callsTo('POST /v1/notifications/read')).toHaveLength(0);
  });

  it('6.2: o POST /read falhou: o ponto volta a refletir o servidor', async () => {
    let unread = 4;
    await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on('GET /v1/notifications', {
          status: 200,
          body: notificationsPage([liked(), liked()]),
        });
        fake.on('GET /v1/notifications/unread-count', () => ({
          status: 200,
          body: { count: unread },
        }));
        fake.on('POST /v1/notifications/read', () => {
          unread = 4;
          return { status: 503, body: { code: 'SERVICE_UNAVAILABLE', message: 'x' } };
        });
      },
    });
    await userEvent.press(
      await screen.findByRole('button', { name: 'Notificações, há novidades' }),
    );
    await screen.findByText(NOTIFICATIONS_END);
    await userEvent.press(screen.getByRole('button', { name: 'Voltar' }));
    expect(
      await screen.findByRole('button', { name: 'Notificações, há novidades' }),
    ).toBeOnTheScreen();
  });

  it('D11/A-07: com profileVisible falso o @ é texto não tocável; com verdadeiro abre o perfil na aba Início', async () => {
    const hidden = commented({
      actor: actor({ handle: 'desconhecida', name: 'Pessoa', profileVisible: false }),
    });
    const visible = liked({ actor: actor({ handle: 'marinac' }), updatedAt: minutesAgo(30) });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: PERSONAL,
      configure: (fake) => {
        notificationsApi(fake, [hidden, visible]);
        fake.on('GET /v1/users/marinac', {
          status: 404,
          body: { code: 'NOT_FOUND', message: 'x' },
        });
        fake.on('GET /v1/users/marinac/posts', {
          status: 404,
          body: { code: 'NOT_FOUND', message: 'x' },
        });
      },
    });
    const hiddenRow = await screen.findByTestId(`notificacao-${hidden.id}`);
    const hiddenHandle = within(hiddenRow).getByText('desconhecida');
    expect(hiddenHandle.props.onPress).toBeUndefined();
    expect(hiddenRow.props.accessibilityActions).toEqual(undefined);
    const visibleRow = screen.getByTestId(`notificacao-${visible.id}`);
    expect(visibleRow.props.accessibilityActions).toContainEqual({
      name: 'profile',
      label: 'Abrir o perfil de @marinac',
    });
    await userEvent.press(within(visibleRow).getByText('marinac'));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio/u/marinac');
    });
  });

  it('6.1: tocar numa foto abre o detalhe na aba Início; num reel, o visualizador', async () => {
    const photo = liked({ updatedAt: minutesAgo(5) });
    const reel = reelPost();
    const onReel = commented({
      post: notifiedPost({ id: reel.id, type: 'reel' }),
      updatedAt: minutesAgo(10),
    });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: PERSONAL,
      configure: (fake) => {
        notificationsApi(fake, [photo, onReel]);
        fake.on(`GET /v1/posts/${reel.id}`, { status: 200, body: reel });
        fake.on(`GET /v1/posts/${photo.type === 'post_liked' ? photo.post.id : ''}`, {
          status: 404,
          body: { code: 'NOT_FOUND', message: 'x' },
        });
      },
    });
    await userEvent.press(await screen.findByLabelText(/comentou no seu reel/));
    await waitFor(() => {
      expect(screen).toHavePathname(`/reel/${reel.id}`);
    });
    expect(screen.getByTestId('reel-viewer')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Fechar' }));
    await waitFor(() => {
      expect(screen).toHavePathname(PERSONAL);
    });
    await userEvent.press(screen.getByLabelText(/curtiu sua foto/));
    await waitFor(() => {
      expect(screen).toHavePathname(
        `/pessoal/inicio/p/${photo.type === 'post_liked' ? photo.post.id : ''}`,
      );
    });
  });

  it('6.1: "conectados" abre o perfil da conexão', async () => {
    const connection = connected({ actor: actor({ handle: 'caio.r', name: 'Caio Ribeiro' }) });
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: PERSONAL,
      configure: (fake) => {
        notificationsApi(fake, [connection]);
        fake.on('GET /v1/users/caio.r', { status: 404, body: { code: 'NOT_FOUND', message: 'x' } });
        fake.on('GET /v1/users/caio.r/posts', {
          status: 404,
          body: { code: 'NOT_FOUND', message: 'x' },
        });
      },
    });
    await userEvent.press(await screen.findByLabelText(/Você e caio\.r estão conectados/));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio/u/caio.r');
    });
  });

  it('estado vazio (ux.md §5.1)', async () => {
    await renderApp({ signedInAs: personalMe(), initialUrl: PERSONAL });
    expect(await screen.findByText(NOTIFICATIONS_EMPTY_TITLE)).toBeOnTheScreen();
    expect(screen.getByText(NOTIFICATIONS_EMPTY_TEXT)).toBeOnTheScreen();
    expect(screen.queryByText(NOTIFICATIONS_END)).not.toBeOnTheScreen();
  });

  it('erro na primeira página: "Tentar de novo" carrega de novo', async () => {
    let calls = 0;
    const item = liked();
    await renderApp({
      signedInAs: personalMe(),
      initialUrl: PERSONAL,
      configure: (fake) => {
        fake.on('GET /v1/notifications', () => {
          calls += 1;
          return calls === 1
            ? { status: 503, body: { code: 'SERVICE_UNAVAILABLE', message: 'x' } }
            : { status: 200, body: notificationsPage([item]) };
        });
      },
    });
    expect(await screen.findByText(NOTIFICATIONS_ERROR_TITLE)).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByTestId(`notificacao-${item.id}`)).toBeOnTheScreen();
  });

  it('paginação por cursor, "Não carregou" na página seguinte e o fim só na última', async () => {
    const page1 = [liked({ updatedAt: minutesAgo(1) })];
    const page2 = [liked({ updatedAt: minutesAgo(2) })];
    let failNext = true;
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: PERSONAL,
      configure: (fake) => {
        fake.on('GET /v1/notifications', ({ query }) => {
          if (query.cursor === undefined) {
            return { status: 200, body: notificationsPage(page1, 'c2') };
          }
          if (failNext) {
            failNext = false;
            return { status: 503, body: { code: 'SERVICE_UNAVAILABLE', message: 'x' } };
          }
          return { status: 200, body: notificationsPage(page2) };
        });
        fake.on('POST /v1/notifications/read', { status: 200, body: { count: 0 } });
      },
    });
    await screen.findByTestId(`notificacao-${page1[0]!.id}`);
    expect(screen.queryByText(NOTIFICATIONS_END)).not.toBeOnTheScreen();
    await scrollListToEnd(screen.getByTestId('notificacoes-lista'));
    expect(await screen.findByTestId('notificacoes-mais-falhou')).toBeOnTheScreen();
    await userEvent.press(
      within(screen.getByTestId('notificacoes-mais-falhou')).getByRole('button', {
        name: 'Tentar de novo',
      }),
    );
    expect(await screen.findByTestId(`notificacao-${page2[0]!.id}`)).toBeOnTheScreen();
    expect(screen.getByText(NOTIFICATIONS_END)).toBeOnTheScreen();
    expect(api.callsTo('GET /v1/notifications').map((call) => call.query.cursor ?? null)).toEqual([
      null,
      'c2',
      'c2',
    ]);
  });

  it('puxar para atualizar busca a primeira página e marca a nova como lida', async () => {
    const old = liked({ updatedAt: minutesAgo(30) });
    const fresh = commented({ updatedAt: minutesAgo(1) });
    let calls = 0;
    const { api } = await renderApp({
      signedInAs: personalMe(),
      initialUrl: PERSONAL,
      configure: (fake) => {
        fake.on('GET /v1/notifications', () => {
          calls += 1;
          return { status: 200, body: notificationsPage(calls === 1 ? [old] : [fresh, old]) };
        });
        fake.on('POST /v1/notifications/read', { status: 200, body: { count: 0 } });
      },
    });
    await screen.findByTestId(`notificacao-${old.id}`);
    await refreshList();
    expect(await screen.findByTestId(`notificacao-${fresh.id}`)).toBeOnTheScreen();
    await waitFor(() => {
      expect(api.callsTo('POST /v1/notifications/read').map((call) => call.body)).toEqual([
        { upTo: old.updatedAt },
        { upTo: fresh.updatedAt },
      ]);
    });
  });
});

describe('Notificações do criador (p21, 6.3)', () => {
  it('6.3 CA1/CA6/NOT-05: seguidores no singular e no plural com o avatar "+N", sem ninguém nomeado', async () => {
    const one = followers(1, { updatedAt: minutesAgo(10) });
    const three = followers(3, { updatedAt: daysAgo(1), read: true });
    await renderApp({
      signedInAs: creatorMe(),
      initialUrl: CREATOR,
      configure: (fake) => {
        notificationsApi(fake, [one, three]);
      },
    });
    // O "N novas pessoas" vem num pedaço próprio (`count`, em 600); o rótulo da linha tem a frase.
    expect(await screen.findByText('1 nova pessoa')).toBeOnTheScreen();
    expect(screen.getByText('3 novas pessoas')).toBeOnTheScreen();
    expect(screen.getByLabelText(/^1 nova pessoa começou a seguir você\. /)).toBeOnTheScreen();
    expect(screen.getByLabelText(/^3 novas pessoas começaram a seguir você\. /)).toBeOnTheScreen();
    expect(screen.getByText('+1', { includeHiddenElements: true })).toBeOnTheScreen();
    expect(screen.getByText('+3', { includeHiddenElements: true })).toBeOnTheScreen();
    // A linha de seguidores não é tocável (não há post nem pessoa).
    expect(
      within(screen.getByTestId(`notificacao-${one.id}`)).queryByRole('button'),
    ).not.toBeOnTheScreen();
    expect(screen.getByTestId(`notificacao-${one.id}`).props.accessibilityRole).toBeUndefined();
    expect(screen.getByRole('header', { name: 'Notificações' })).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Notificações' })).toBeSelected();
  });

  it('6.2: a aba Notificações do criador tem o ponto e ele some ao abrir', async () => {
    await renderApp({
      signedInAs: creatorMe(),
      configure: (fake) => {
        notificationsApi(fake, [followers(2)], 1);
      },
    });
    const tab = await screen.findByRole('tab', { name: 'Notificações, há novidades' });
    await userEvent.press(tab);
    await screen.findByText('2 novas pessoas');
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Notificações' })).toBeSelected();
    });
    expect(screen.queryByTestId('tabbar-creator-unread')).not.toBeOnTheScreen();
  });

  it('o comentário no reel do criador abre o visualizador; o @ de conta pessoal não é tocável', async () => {
    const reel = reelPost({
      isOwn: true,
      author: {
        handle: 'cozinhadabia',
        name: 'Beatriz Lemos',
        avatarUrl: null,
        accountType: 'creator',
      },
    });
    const notification = commented({
      actor: actor({ handle: 'lucasf', profileVisible: false }),
      post: notifiedPost({ id: reel.id, type: 'reel' }),
    });
    await renderApp({
      signedInAs: creatorMe(),
      initialUrl: CREATOR,
      configure: (fake) => {
        notificationsApi(fake, [notification]);
        fake.on(`GET /v1/posts/${reel.id}`, { status: 200, body: reel });
      },
    });
    const row = await screen.findByTestId(`notificacao-${notification.id}`);
    expect(within(row).getByText('lucasf').props.onPress).toBeUndefined();
    expect(within(row).getByText(' comentou no seu reel: ')).toBeOnTheScreen();
    await userEvent.press(row);
    await waitFor(() => {
      expect(screen).toHavePathname(`/reel/${reel.id}`);
    });
  });

  it('a foto do criador abre o detalhe dentro da aba Notificações', async () => {
    const id = uuid();
    const notification = liked({ post: notifiedPost({ id }) });
    await renderApp({
      signedInAs: creatorMe(),
      initialUrl: CREATOR,
      configure: (fake) => {
        notificationsApi(fake, [notification]);
        fake.on(`GET /v1/posts/${id}`, { status: 404, body: { code: 'NOT_FOUND', message: 'x' } });
      },
    });
    await userEvent.press(await screen.findByTestId(`notificacao-${notification.id}`));
    await waitFor(() => {
      expect(screen).toHavePathname(`/criador/notificacoes/p/${id}`);
    });
    expect(screen.getByRole('tab', { name: 'Notificações' })).toBeSelected();
  });
});

describe('p/[id] de um reel (pendência da 5b)', () => {
  it('abre o visualizador no lugar do detalhe; fechar volta para onde a pessoa estava', async () => {
    const reel = reelPost();
    await renderApp({
      signedInAs: personalMe(),
      configure: (fake) => {
        fake.on(`GET /v1/posts/${reel.id}`, { status: 200, body: reel });
      },
    });
    await screen.findByTestId('tela-inicio');
    await act(async () => {
      router.push(`/pessoal/inicio/p/${reel.id}`);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(screen).toHavePathname(`/reel/${reel.id}`);
    });
    expect(screen.getByTestId('reel-viewer')).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('button', { name: 'Fechar' }));
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/inicio');
    });
    expect(screen.queryByTestId('tela-publicacao')).not.toBeOnTheScreen();
  });
});
