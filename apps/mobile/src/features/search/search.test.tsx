import { userEvent } from '@testing-library/react-native';
import { act, screen, waitFor, within } from 'expo-router/testing-library';

import { SEARCH_EMPTY, SEARCH_HINT, SEARCH_MIN_HINT } from './SearchScreen';
import { NetworkError } from '../../lib/api/errors';
import { creatorMe, personalMe } from '../../test-utils/fake-api';
import {
  creatorProfile,
  deferredReply,
  RATE_LIMITED,
  searchItem,
} from '../../test-utils/relation-fixtures';
import { renderApp, type RenderAppOptions } from '../../test-utils/render-app';
import { FOLLOW_ERROR_MESSAGE } from '../relations/useFollowToggle';

const SEARCH = 'GET /v1/search/creators';
const LABEL = 'Pesquisar @criador';

afterEach(() => {
  jest.restoreAllMocks();
});

/**
 * Roda os timers e efeitos pendentes (o renderRouter usa timers falsos; a pausa da busca é 0 nos
 * testes): depois disso, uma chamada que fosse sair já teria saído.
 */
async function settle() {
  await act(async () => {
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
  });
}

async function openSearch(configure?: RenderAppOptions['configure']) {
  const result = await renderApp({
    signedInAs: personalMe(),
    initialUrl: '/pessoal/pesquisar',
    ...(configure === undefined ? {} : { configure }),
  });
  const input = await screen.findByLabelText(LABEL);
  return { ...result, input };
}

describe('Pesquisar (histórias 3.1 e 3.2)', () => {
  it('BUS-09 (3.1 CA8): sem sugestões; só a dica "Digite o @ de um criador.", sem chamar a API', async () => {
    const { api } = await openSearch();
    expect(screen.getByText(SEARCH_HINT)).toBeOnTheScreen();
    expect(screen.getByRole('tab', { name: 'Pesquisar' })).toBeSelected();
    await settle();
    expect(api.callsTo(SEARCH)).toHaveLength(0);
  });

  it('BUS-11 (3.1 CA2): com 1 ou 2 letras (o "@" não conta) mostra "Digite pelo menos 3 letras." e não chama a API', async () => {
    const { api, input } = await openSearch();
    await userEvent.type(input, '@e');
    expect(screen.getByText(SEARCH_MIN_HINT)).toBeOnTheScreen();
    await userEvent.type(input, 's');
    expect(screen.getByText(SEARCH_MIN_HINT)).toBeOnTheScreen();
    await settle();
    expect(api.callsTo(SEARCH)).toHaveLength(0);

    // Fora do alfabeto do @ (BUS-06): o app também não chama, e diz o porquê.
    await userEvent.clear(input);
    await userEvent.paste(input, 'ab%');
    expect(screen.getByText('Use só letras, números, ponto e sublinhado.')).toBeOnTheScreen();
    await settle();
    expect(api.callsTo(SEARCH)).toHaveLength(0);

    // Apagar tudo volta à dica inicial.
    await userEvent.clear(input);
    expect(screen.getByText(SEARCH_HINT)).toBeOnTheScreen();
  });

  it('3.2 CA1/BUS-11 (A-04): sem criador, a mesma mensagem para um @ pessoal e para um inexistente', async () => {
    const { api, input } = await openSearch((fake) => {
      fake.on(SEARCH, { status: 200, body: { items: [] } });
    });
    await userEvent.paste(input, 'helena');
    expect(await screen.findByText(SEARCH_EMPTY)).toBeOnTheScreen();
    await userEvent.clear(input);
    await userEvent.paste(input, 'naoexiste');
    expect(await screen.findByText(SEARCH_EMPTY)).toBeOnTheScreen();
    expect(
      screen.getByText(
        'Nenhum criador com esse @. Contas pessoais não aparecem na busca: elas só se conectam ao vivo.',
      ),
    ).toBeOnTheScreen();
    expect(api.callsTo(SEARCH).map((call) => call.query.q)).toEqual(['helena', 'naoexiste']);
  });

  it('3.1 (p15, BUS-03, BUS-10): itens com nome, @, seguidores e Seguir/Seguindo; o item abre o perfil na aba Pesquisar', async () => {
    const { api, input } = await openSearch((fake) => {
      fake.on(SEARCH, {
        status: 200,
        body: {
          items: [
            searchItem(),
            searchItem({ handle: 'estudiozen', name: 'Estúdio Zen', followedByMe: true }),
          ],
        },
      });
      fake.on('GET /v1/users/estudioaurora', {
        status: 200,
        body: creatorProfile({ handle: 'estudioaurora', name: 'Estúdio Aurora' }),
      });
      fake.on('GET /v1/users/estudioaurora/posts', {
        status: 200,
        body: { items: [], nextCursor: null },
      });
    });
    await userEvent.paste(input, ' @Estu ');
    expect(await screen.findByText('estudioaurora')).toBeOnTheScreen();
    // O app normaliza como a API (trim, sem "@", minúsculas).
    expect(api.callsTo(SEARCH).at(-1)?.query).toEqual({ q: 'estu' });
    expect(screen.getByText('Estúdio Aurora · 5.067 seguidores')).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Seguir @estudioaurora' })).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Seguindo @estudiozen, toque para deixar de seguir' }),
    ).toBeOnTheScreen();

    await userEvent.press(
      screen.getByRole('button', { name: '@estudioaurora, Estúdio Aurora · 5.067 seguidores' }),
    );
    await waitFor(() => {
      expect(screen).toHavePathname('/pessoal/pesquisar/u/estudioaurora');
    });
    expect(await screen.findByRole('header', { name: 'estudioaurora' })).toBeOnTheScreen();
    // Rota compartilhada: a aba de origem continua ativa (ux.md §3.2).
    expect(screen.getByRole('tab', { name: 'Pesquisar' })).toBeSelected();
  });

  it('erro: linha com a mensagem e "Tentar de novo"; 429 também (A-31)', async () => {
    let reply: 'network' | 'rate' | 'ok' = 'network';
    const { input } = await openSearch((fake) => {
      fake.on(SEARCH, () => {
        if (reply === 'network') throw new NetworkError();
        if (reply === 'rate') return RATE_LIMITED;
        return { status: 200, body: { items: [searchItem()] } };
      });
    });
    await userEvent.paste(input, 'estu');
    const error = await screen.findByTestId('busca-erro');
    expect(within(error).getByText('Sem conexão com a internet. Tente de novo.')).toBeOnTheScreen();

    reply = 'rate';
    await userEvent.press(within(error).getByRole('button', { name: 'Tentar de novo' }));
    expect(
      await screen.findByText('Muitas tentativas. Espere um pouco e tente de novo.'),
    ).toBeOnTheScreen();

    reply = 'ok';
    await userEvent.press(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(await screen.findByText('estudioaurora')).toBeOnTheScreen();
  });
});

describe('Seguir/Seguindo (história 3.3)', () => {
  it('3.3 CA1/CNT-02: Seguir é otimista e o número de "criadores" do próprio perfil sobe na hora', async () => {
    const put = deferredReply();
    let followed = false;
    const { api, input } = await openSearch((fake) => {
      fake.on(SEARCH, { status: 200, body: { items: [searchItem()] } });
      fake.on('PUT /v1/creators/estudioaurora/follow', async () => {
        const reply = await put.handler();
        followed = true;
        return reply;
      });
      // Depois do sucesso, o GET /me já conta o follow (CNT-03).
      fake.on('GET /v1/me', () => ({
        status: 200,
        body: personalMe({ counts: { posts: 5, connections: 4, creators: followed ? 4 : 3 } }),
      }));
    });
    await userEvent.paste(input, 'estu');
    await userEvent.press(await screen.findByRole('button', { name: 'Seguir @estudioaurora' }));
    // A resposta ainda não chegou: o botão e o número já mudaram.
    expect(
      screen.getByRole('button', { name: 'Seguindo @estudioaurora, toque para deixar de seguir' }),
    ).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('tab', { name: 'Perfil' }));
    expect(await screen.findByLabelText('4 criadores')).toBeOnTheScreen();

    await put.resolve({ status: 200, body: { following: true } });
    await waitFor(() => {
      expect(api.callsTo('GET /v1/me').length).toBeGreaterThan(1);
    });
    expect(screen.getByLabelText('4 criadores')).toBeOnTheScreen();
  });

  it('3.3 CA6: falha de rede → o botão volta para "Seguir", o número volta e aparece o Toast', async () => {
    const { input } = await openSearch((fake) => {
      fake.on(SEARCH, { status: 200, body: { items: [searchItem()] } });
      fake.on('PUT /v1/creators/estudioaurora/follow', () => {
        throw new NetworkError();
      });
    });
    await userEvent.paste(input, 'estu');
    await userEvent.press(await screen.findByRole('button', { name: 'Seguir @estudioaurora' }));
    expect(await screen.findByText(FOLLOW_ERROR_MESSAGE)).toBeOnTheScreen();
    expect(screen.getByRole('button', { name: 'Seguir @estudioaurora' })).toBeOnTheScreen();
    await userEvent.press(screen.getByRole('tab', { name: 'Perfil' }));
    expect(await screen.findByLabelText('3 criadores')).toBeOnTheScreen();
  });

  it('3.3 CA5: 429 → volta para "Seguindo" e o Toast de muitas tentativas', async () => {
    const { input } = await openSearch((fake) => {
      fake.on(SEARCH, {
        status: 200,
        body: { items: [searchItem({ followedByMe: true })] },
      });
      fake.on('DELETE /v1/creators/estudioaurora/follow', RATE_LIMITED);
    });
    await userEvent.paste(input, 'estu');
    await userEvent.press(
      await screen.findByRole('button', {
        name: 'Seguindo @estudioaurora, toque para deixar de seguir',
      }),
    );
    expect(
      await screen.findByText('Muitas tentativas. Espere um pouco e tente de novo.'),
    ).toBeOnTheScreen();
    expect(
      screen.getByRole('button', { name: 'Seguindo @estudioaurora, toque para deixar de seguir' }),
    ).toBeOnTheScreen();
  });
});

describe('tipo de conta (história 1.9, Fase 3b)', () => {
  it('criador não tem Pesquisar: o deep link volta ao Perfil sem chamar a busca nem as listas', async () => {
    const { api } = await renderApp({ signedInAs: creatorMe(), initialUrl: '/pessoal/pesquisar' });
    await waitFor(() => {
      expect(screen).toHavePathname('/criador/perfil');
    });
    expect(screen.queryByRole('tab', { name: 'Pesquisar' })).not.toBeOnTheScreen();
    expect(screen.queryByLabelText(LABEL)).not.toBeOnTheScreen();
    await settle();
    expect(api.callsTo(SEARCH)).toHaveLength(0);
  });

  it.each(['/pessoal/perfil/seguindo', '/pessoal/perfil/conexoes'])(
    'criador com deep link para %s volta ao Perfil (listas só da conta pessoal, PERM-05)',
    async (url) => {
      const { api } = await renderApp({ signedInAs: creatorMe(), initialUrl: url });
      await waitFor(() => {
        expect(screen).toHavePathname('/criador/perfil');
      });
      await settle();
      expect(api.callsTo('GET /v1/me/following')).toHaveLength(0);
      expect(api.callsTo('GET /v1/me/connections')).toHaveLength(0);
    },
  );
});
