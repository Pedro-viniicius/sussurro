import { theme, UiPreferencesProvider } from '@sussurro/ui';
import { act, render, screen, userEvent, within } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { AccessibilityInfo, Animated, StyleSheet } from 'react-native';

import { COPY } from './copy';
import { connectTiming } from './timing';
import { TouchCard, type TouchCardModeration } from './TouchCard';
import { blockedMessage } from '../moderation/useBlockAccount';

const CAIO = { handle: 'caio.r', name: 'Caio Ribeiro', avatarUrl: null };

function moderation(overrides: Partial<TouchCardModeration> = {}): TouchCardModeration {
  return {
    visible: true,
    canBlock: true,
    blocking: false,
    disabled: false,
    onReport: jest.fn(),
    onBlock: jest.fn(),
    ...overrides,
  };
}

const COMMON = { focusRun: 0, focusHeld: false };

async function renderCard(card: ReactElement, reduceMotion = true) {
  return render(<UiPreferencesProvider reduceMotion={reduceMotion}>{card}</UiPreferencesProvider>);
}

/** Os rótulos dos botões do cartão, na ordem de leitura. */
function buttonLabels(): string[] {
  return screen.getAllByRole('button').map((node) => String(node.props.accessibilityLabel));
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.mocked(AccessibilityInfo.sendAccessibilityEvent).mockClear();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('TouchCard (ux.md §11.5)', () => {
  it('11 (encostado): nome (header), @, T15, "Conectar com Caio" (leitor: nome e @) e Cancelar; o foco vai ao nome', async () => {
    const onConnect = jest.fn();
    const onCancel = jest.fn();
    await renderCard(
      <TouchCard
        variant="touched"
        person={CAIO}
        busy={false}
        onConnect={onConnect}
        onCancel={onCancel}
        moderation={moderation()}
        {...COMMON}
      />,
    );
    expect(screen.getByTestId('conectar-encostado')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
    expect(screen.getByText('@caio.r')).toBeOnTheScreen();
    expect(screen.getByText(COPY.cardCheck)).toBeOnTheScreen();
    const connect = screen.getByRole('button', { name: 'Conectar com Caio Ribeiro, @caio.r' });
    expect(screen.getByText('Conectar com Caio')).toBeOnTheScreen();

    // Foco no nome uns 300 ms depois (ux.md §11.8).
    expect(AccessibilityInfo.sendAccessibilityEvent).not.toHaveBeenCalled();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(connectTiming.focusDelayMs);
    });
    expect(AccessibilityInfo.sendAccessibilityEvent).toHaveBeenCalledWith(
      expect.anything(),
      'focus',
    );

    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.press(connect);
    await user.press(screen.getByRole('button', { name: COPY.cancel }));
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('enviando o pedido: o botão fica ocupado e o Cancelar desabilitado', async () => {
    await renderCard(
      <TouchCard
        variant="touched"
        person={CAIO}
        busy
        onConnect={jest.fn()}
        onCancel={jest.fn()}
        moderation={moderation({ disabled: true })}
        {...COMMON}
      />,
    );
    expect(screen.getByRole('button', { name: 'Conectar com Caio Ribeiro, @caio.r' })).toBeBusy();
    expect(screen.getByRole('button', { name: COPY.cancel })).toBeDisabled();
  });

  it('12 (já conectados): T18 e Voltar, sem o botão de conectar', async () => {
    const onBack = jest.fn();
    await renderCard(
      <TouchCard
        variant="alreadyConnected"
        person={CAIO}
        onBack={onBack}
        moderation={moderation()}
        {...COMMON}
      />,
    );
    expect(screen.getByTestId('conectar-encostado-conectados')).toBeOnTheScreen();
    expect(screen.getByText(COPY.alreadyConnected)).toBeOnTheScreen();
    expect(screen.queryByText('Conectar com Caio')).toBeNull();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.press(screen.getByRole('button', { name: COPY.back }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('14 (pedido no cartão): título, @ · nome, confirmação, Aceitar no mesmo lugar, Recusar, prazo e o erro do aceite', async () => {
    const onAccept = jest.fn();
    const onDecline = jest.fn();
    await renderCard(
      <TouchCard
        variant="incoming"
        person={{ handle: 'helena', name: 'Helena Souza', avatarUrl: null }}
        secondsLeft={105}
        busy={false}
        error={COPY.notSeen('Helena')}
        onAccept={onAccept}
        onDecline={onDecline}
        moderation={moderation()}
        {...COMMON}
      />,
    );
    expect(screen.getByTestId('conectar-pedido-cartao')).toBeOnTheScreen();
    expect(screen.getByRole('header', { name: 'Helena quer se conectar' })).toBeOnTheScreen();
    expect(screen.getByText('@helena · Helena Souza')).toBeOnTheScreen();
    expect(screen.getByText(COPY.sheetConfirm('Helena'))).toBeOnTheScreen();
    expect(screen.getByTestId('cartao-prazo')).toHaveTextContent('Expira em 1:45');
    expect(screen.getByTestId('cartao-erro')).toHaveTextContent(COPY.notSeen('Helena'));
    // O botão principal fica no mesmo lugar do "Conectar" (P5).
    expect(screen.getByTestId('cartao-principal')).toHaveTextContent(COPY.accept);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.press(screen.getByRole('button', { name: COPY.accept }));
    await user.press(screen.getByRole('button', { name: COPY.decline }));
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onDecline).toHaveBeenCalledTimes(1);
  });
});

describe('TouchCard: cartão atrasado e cartão sem Conectar (ux.md §11.15; PROX-70)', () => {
  it('PROX-70 (21): nome (header), @, o T47 com o primeiro nome e só o (Voltar) — sem Conectar, sem ‹Cancelar› e sem a linha; o foco vai ao nome', async () => {
    const onBack = jest.fn();
    await renderCard(
      <TouchCard
        variant="late"
        person={CAIO}
        onBack={onBack}
        moderation={moderation()}
        {...COMMON}
      />,
    );
    const card = screen.getByTestId('conectar-encostado-atrasado');
    expect(within(card).getByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
    expect(screen.getByText('@caio.r')).toBeOnTheScreen();
    expect(screen.getByText(COPY.lateCardText('Caio'))).toBeOnTheScreen();
    expect(COPY.lateCardText('Caio')).toBe(
      'O tempo para conectar acabou. Para tentar de novo, toque em Voltar e encoste o seu celular no de Caio.',
    );
    expect(screen.queryByText(COPY.cardCheck)).toBeNull();
    // Ordem de leitura: nome → @ → T47 → Voltar.
    expect(buttonLabels()).toEqual([COPY.back]);
    expect(screen.queryByTestId('cartao-denunciar', { includeHiddenElements: true })).toBeNull();
    expect(screen.queryByTestId('cartao-bloquear', { includeHiddenElements: true })).toBeNull();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(connectTiming.focusDelayMs);
    });
    expect(
      (
        jest.mocked(AccessibilityInfo.sendAccessibilityEvent).mock.calls[0]?.[0] as unknown as {
          props?: { testID?: string };
        }
      ).props?.testID,
    ).toBe('cartao-nome');
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.press(screen.getByRole('button', { name: COPY.back }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('PROX-70 (22): o T48 no lugar do T15, o (Voltar) no lugar do Conectar e do ‹Cancelar›, e a linha ‹Denunciar› ‹Bloquear› por último', async () => {
    const onBack = jest.fn();
    const lineActions = moderation();
    await renderCard(
      <TouchCard
        variant="noConnect"
        person={CAIO}
        onBack={onBack}
        moderation={lineActions}
        {...COMMON}
      />,
    );
    expect(screen.getByTestId('conectar-encostado-sem-conectar')).toBeOnTheScreen();
    expect(screen.getByText(COPY.noConnectCardText('Caio'))).toBeOnTheScreen();
    expect(COPY.noConnectCardText('Caio')).toBe(
      'Para conectar, toque em Voltar e encoste de novo o seu celular no de Caio.',
    );
    expect(screen.queryByText(COPY.cardCheck)).toBeNull();
    expect(screen.queryByText('Conectar com Caio')).toBeNull();
    // Ordem de leitura: nome → @ → T48 → Voltar → Denunciar → Bloquear.
    expect(buttonLabels()).toEqual([COPY.back, 'Denunciar', 'Bloquear']);
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.press(screen.getByRole('button', { name: COPY.back }));
    await user.press(screen.getByTestId('cartao-bloquear'));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(lineActions.onBlock).toHaveBeenCalledTimes(1);
  });

  it('PROX-70 (22, M3): bloqueando, o (Voltar) e o ‹Denunciar› ficam desativados e o ‹Bloquear› em loading', async () => {
    await renderCard(
      <TouchCard
        variant="noConnect"
        person={CAIO}
        onBack={jest.fn()}
        moderation={moderation({ blocking: true })}
        {...COMMON}
      />,
    );
    expect(screen.getByRole('button', { name: COPY.back })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Denunciar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Bloquear' })).toBeBusy();
  });

  it('PROX-70 (14 do cartão atrasado): a linha que nunca esteve na tela não aparece, nem para sumir com o fade', async () => {
    await renderCard(
      <TouchCard
        variant="incoming"
        person={CAIO}
        secondsLeft={100}
        busy={false}
        error={null}
        onAccept={jest.fn()}
        onDecline={jest.fn()}
        moderation={moderation({ visible: false })}
        {...COMMON}
      />,
      false,
    );
    expect(screen.queryByTestId('cartao-denunciar', { includeHiddenElements: true })).toBeNull();
    expect(buttonLabels()).toEqual([COPY.accept, COPY.decline]);
  });

  it.each([
    ['sem Reduzir movimento', false],
    ['com Reduzir movimento', true],
  ] as const)(
    'PROX-69 (§11.15, %s): o cartão (também o que chega no QR) entra com fade de 200 ms; com Reduzir movimento, sem fade',
    async (_case, reduceMotion) => {
      const timing = jest.spyOn(Animated, 'timing');
      await renderCard(
        <TouchCard
          variant="late"
          person={CAIO}
          onBack={jest.fn()}
          moderation={moderation()}
          {...COMMON}
        />,
        reduceMotion,
      );
      const opacity = StyleSheet.flatten(
        screen.getByTestId('conectar-encostado-atrasado').props.style,
      ).opacity as number;
      const fades = timing.mock.calls.filter(([, config]) => config.toValue === 1);
      if (reduceMotion) {
        expect(opacity).toBe(1);
        expect(fades).toHaveLength(0);
      } else {
        expect(opacity).toBe(0);
        expect(fades.map(([, config]) => config.duration)).toEqual([theme.motion.base]);
        expect(theme.motion.base).toBe(200);
      }
      timing.mockRestore();
    },
  );
});

describe('TouchCard: bloquear e denunciar pelo cartão (ux.md §11.14)', () => {
  it('PROX-61 / PROX-62 (11): a linha vem por último, "Denunciar" e depois "Bloquear", link sm com alvo de 44 (hitSlop), nenhum vermelho', async () => {
    const lineActions = moderation();
    await renderCard(
      <TouchCard
        variant="touched"
        person={CAIO}
        busy={false}
        onConnect={jest.fn()}
        onCancel={jest.fn()}
        moderation={lineActions}
        {...COMMON}
      />,
    );
    // Ordem de leitura do 11: Conectar → Cancelar → Denunciar → Bloquear.
    expect(buttonLabels()).toEqual([
      COPY.connectWithLabel('Caio Ribeiro', 'caio.r'),
      COPY.cancel,
      'Denunciar',
      'Bloquear',
    ]);
    const report = screen.getByTestId('cartao-denunciar');
    const block = screen.getByTestId('cartao-bloquear');
    for (const action of [report, block]) {
      // Button sm (34) + hitSlop vertical de 5 = 44.
      expect(action.props.hitSlop).toEqual({ top: 5, bottom: 5 });
    }
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.press(report);
    await user.press(block);
    expect(lineActions.onReport).toHaveBeenCalledTimes(1);
    expect(lineActions.onBlock).toHaveBeenCalledTimes(1);
  });

  it('PROX-61 (M3): bloqueando, o ‹Bloquear› fica em loading e Conectar, Cancelar e Denunciar ficam desativados', async () => {
    await renderCard(
      <TouchCard
        variant="touched"
        person={CAIO}
        busy={false}
        onConnect={jest.fn()}
        onCancel={jest.fn()}
        moderation={moderation({ blocking: true })}
        {...COMMON}
      />,
    );
    expect(screen.getByRole('button', { name: 'Bloquear' })).toBeBusy();
    expect(screen.getByRole('button', { name: 'Denunciar' })).toBeDisabled();
    expect(screen.getByRole('button', { name: COPY.cancel })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Conectar com Caio Ribeiro, @caio.r' }),
    ).toBeDisabled();
  });

  it('PROX-61 / PROX-62 (12 e 14): a linha vem depois do Voltar e depois do prazo; no 14, Aceitar e Recusar desativados enquanto bloqueia', async () => {
    const { rerender } = await renderCard(
      <TouchCard
        variant="alreadyConnected"
        person={CAIO}
        onBack={jest.fn()}
        moderation={moderation()}
        {...COMMON}
      />,
    );
    expect(buttonLabels()).toEqual([COPY.back, 'Denunciar', 'Bloquear']);
    await rerender(
      <UiPreferencesProvider reduceMotion>
        <TouchCard
          variant="incoming"
          person={CAIO}
          secondsLeft={100}
          busy={false}
          error={null}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
          moderation={moderation({ blocking: true })}
          {...COMMON}
        />
      </UiPreferencesProvider>,
    );
    expect(buttonLabels()).toEqual([COPY.accept, COPY.decline, 'Denunciar', 'Bloquear']);
    expect(screen.getByRole('button', { name: COPY.accept })).toBeDisabled();
    expect(screen.getByRole('button', { name: COPY.decline })).toBeDisabled();
  });

  it('PROX-61 (Bloqueado): o nome é o título, o blockedMessage no lugar do T15, o Voltar e só o ‹Denunciar›', async () => {
    const onBack = jest.fn();
    await renderCard(
      <TouchCard
        variant="blocked"
        person={CAIO}
        onBack={onBack}
        moderation={moderation({ canBlock: false })}
        {...COMMON}
      />,
    );
    const card = screen.getByTestId('conectar-encostado-bloqueado');
    expect(within(card).getByRole('header', { name: 'Caio Ribeiro' })).toBeOnTheScreen();
    expect(screen.getByText(blockedMessage('caio.r'))).toBeOnTheScreen();
    expect(screen.queryByText(COPY.cardCheck)).toBeNull();
    expect(screen.queryByText('Conectar com Caio')).toBeNull();
    expect(buttonLabels()).toEqual([COPY.back, 'Denunciar']);
    expect(screen.queryByTestId('cartao-bloquear')).toBeNull();
    const user = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await user.press(screen.getByRole('button', { name: COPY.back }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('PROX-61 (M14): a linha some com fade de 200 ms (fora do leitor de tela já no começo); com Reduzir movimento, na hora', async () => {
    const props = {
      variant: 'incoming' as const,
      person: CAIO,
      secondsLeft: 60,
      busy: false,
      error: null,
      onAccept: jest.fn(),
      onDecline: jest.fn(),
      ...COMMON,
    };
    const { rerender } = await renderCard(
      <TouchCard {...props} moderation={moderation()} />,
      false,
    );
    expect(screen.getByTestId('cartao-denunciar')).toBeOnTheScreen();
    await rerender(
      <UiPreferencesProvider reduceMotion={false}>
        <TouchCard {...props} moderation={moderation({ visible: false })} />
      </UiPreferencesProvider>,
    );
    // Saindo: ainda desenhada, mas fora do leitor de tela e desativada.
    expect(screen.queryByTestId('cartao-denunciar')).toBeNull();
    expect(screen.getByTestId('cartao-denunciar', { includeHiddenElements: true })).toBeDisabled();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(400);
    });
    expect(screen.queryByTestId('cartao-denunciar', { includeHiddenElements: true })).toBeNull();
    // O pedido continua.
    expect(screen.getByRole('button', { name: COPY.accept })).toBeOnTheScreen();

    await rerender(
      <UiPreferencesProvider reduceMotion>
        <TouchCard {...props} moderation={moderation({ visible: false })} />
      </UiPreferencesProvider>,
    );
    expect(screen.queryByTestId('cartao-denunciar', { includeHiddenElements: true })).toBeNull();
  });

  it('M15 / M16: com o foco segurado, a troca de variante não move o foco; ao liberar, o foco vai ao título; liberar sem troca não move nada (M2)', async () => {
    const focus = jest.mocked(AccessibilityInfo.sendAccessibilityEvent);
    const touched = (held: boolean) => (
      <UiPreferencesProvider reduceMotion>
        <TouchCard
          variant="touched"
          person={CAIO}
          busy={false}
          onConnect={jest.fn()}
          onCancel={jest.fn()}
          moderation={moderation()}
          focusRun={0}
          focusHeld={held}
        />
      </UiPreferencesProvider>
    );
    const { rerender } = await render(touched(false));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(connectTiming.focusDelayMs);
    });
    expect(focus).toHaveBeenCalledTimes(1);
    // O `Alert` abre e fecha sem nada mudar (M2): o foco fica onde o sistema o deixou.
    await rerender(touched(true));
    await rerender(touched(false));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(focus).toHaveBeenCalledTimes(1);
    // O pedido chega com o formulário aberto (M16): nada até fechar; ao fechar, o título.
    await rerender(
      <UiPreferencesProvider reduceMotion>
        <TouchCard
          variant="incoming"
          person={CAIO}
          secondsLeft={100}
          busy={false}
          error={null}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
          moderation={moderation()}
          focusRun={0}
          focusHeld
        />
      </UiPreferencesProvider>,
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(focus).toHaveBeenCalledTimes(1);
    await rerender(
      <UiPreferencesProvider reduceMotion>
        <TouchCard
          variant="incoming"
          person={CAIO}
          secondsLeft={100}
          busy={false}
          error={null}
          onAccept={jest.fn()}
          onDecline={jest.fn()}
          moderation={moderation()}
          focusRun={1}
          focusHeld={false}
        />
      </UiPreferencesProvider>,
    );
    await act(async () => {
      await jest.advanceTimersByTimeAsync(connectTiming.focusDelayMs);
    });
    expect(focus).toHaveBeenCalledTimes(2);
    expect(
      (focus.mock.calls[1]?.[0] as unknown as { props?: { testID?: string } }).props?.testID,
    ).toBe('cartao-titulo');
  });
});
