import { useEffect, useRef } from 'react';
import { AccessibilityInfo, type ViewInstance } from 'react-native';

import { connectTiming } from './timing';

// Leitor de tela na tela Conectar (ux.md §11.8): o foco e os anúncios, nos dois sistemas com o
// `announceForAccessibility` (R1 da §11.13).

/** Anúncio na hora, quando nada muda o foco junto (A1, A2, T11, A6, "Pedido enviado"…). */
export function announce(message: string): void {
  AccessibilityInfo.announceForAccessibility(message);
}

/** Quanto depois de o elemento aparecer sai o anúncio que acompanha o foco: depois do foco e da folga. */
export function announceAfterFocusMs(): number {
  return connectTiming.focusDelayMs + connectTiming.announceAfterFocusMs;
}

/**
 * Primeiro o foco, depois o anúncio (ux.md §11.8): quando um elemento aparece e recebe o foco
 * (`useFocusOnShow`, uns 300 ms depois), o anúncio do mesmo momento sai depois do foco e **em fila**
 * (no iOS, espera a leitura do elemento focado em vez de cortá-la; no Android, é o anúncio comum).
 * Sem isso, a leitura do elemento focado corta o anúncio. Devolve a função que cancela.
 */
export function announceAfterFocus(message: string): () => void {
  const timer = setTimeout(() => {
    AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
  }, announceAfterFocusMs());
  return () => {
    clearTimeout(timer);
  };
}

/**
 * O anúncio que acompanha o foco (`announceAfterFocus`), uma vez por `key`, mas que espera enquanto
 * `held`: o cartão que chega com a folha de outra pessoa aberta, com a câmera saindo no iOS ou com o
 * app em segundo plano (ux.md §11.15). Sai junto com o foco do `useFocusOnShowUnlessHeld`, que
 * espera pelo mesmo motivo: os dois relógios começam quando a espera acaba, e o anúncio sai depois
 * do foco. `key` ou `message` nulos: nada a anunciar.
 */
export function useAnnounceAfterFocusUnlessHeld(
  key: string | null,
  message: string | null,
  held: boolean,
): void {
  const announcedKey = useRef<string | null>(null);
  useEffect(() => {
    if (key === null || message === null || held || announcedKey.current === key) {
      return undefined;
    }
    const timer = setTimeout(() => {
      announcedKey.current = key;
      AccessibilityInfo.announceForAccessibilityWithOptions(message, { queue: true });
    }, announceAfterFocusMs());
    return () => {
      clearTimeout(timer);
    };
  }, [held, key, message]);
}

/**
 * Move o foco do leitor de tela para `ref` uns 300 ms depois de montar (ou de `key` mudar): o nome
 * no cartão, o título no pedido recebido (cartão ou folha), o título do p14 e o do Pronto quando o
 * controle focado sumiu da tela (ux.md §11.8).
 */
export function useFocusOnShow(key: string, enabled = true) {
  const ref = useRef<ViewInstance>(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const timer = setTimeout(() => {
      if (ref.current !== null) AccessibilityInfo.sendAccessibilityEvent(ref.current, 'focus');
    }, connectTiming.focusDelayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [enabled, key]);
  return ref;
}

/**
 * O foco do cabeçalho do cartão (ux.md §11.14): como o `useFocusOnShow`, mas, enquanto `held` (o
 * `Alert` ou o formulário de denúncia por cima), o foco espera. A chave que mudou nesse meio-tempo
 * (o pedido chegou, M16; o formulário fechou, M9 e M12) recebe o foco quando eles fecham. Sem chave
 * nova, liberar não move nada: o sistema devolve o foco a quem abriu o `Alert` (M2).
 */
export function useFocusOnShowUnlessHeld(key: string, held: boolean) {
  const ref = useRef<ViewInstance>(null);
  const focusedKey = useRef<string | null>(null);
  useEffect(() => {
    if (held || focusedKey.current === key) return undefined;
    const timer = setTimeout(() => {
      focusedKey.current = key;
      if (ref.current !== null) AccessibilityInfo.sendAccessibilityEvent(ref.current, 'focus');
    }, connectTiming.focusDelayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [held, key]);
  return ref;
}
