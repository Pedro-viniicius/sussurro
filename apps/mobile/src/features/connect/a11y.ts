import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Platform, type ViewInstance } from 'react-native';

import { connectTiming } from './timing';

// Leitor de tela na tela Conectar (ux.md §11.8): o foco e os anúncios, nos dois sistemas com o
// `announceForAccessibility` (R1 da §11.13).

/** Anúncio na hora, quando nada muda o foco junto ("Código lido", "Pedido enviado"…). */
export function announce(message: string): void {
  AccessibilityInfo.announceForAccessibility(message);
}

/**
 * Anuncia `message` quando ela aparece ou muda, só no iOS (ux.md §11.19, S2): o VoiceOver ignora a
 * `accessibilityLiveRegion`, que no Android já anuncia. Como faz o `ToastProvider`. `null`, nada.
 */
export function useAnnounceOnIos(message: string | null): void {
  useEffect(() => {
    if (message !== null && Platform.OS === 'ios') announce(message);
  }, [message]);
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
 * Move o foco do leitor de tela para `ref` uns 300 ms depois de montar (ou de `key` mudar): o nome
 * no cartão, o título do pedido recebido, o título do p14 e o do início quando o controle focado
 * sumiu da tela (ux.md §11.8).
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
