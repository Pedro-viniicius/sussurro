import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * Preferências de exibição sobrepostas às do sistema. Usadas pelo catálogo (ux.md §6.15) para
 * simular escala de fonte e "Reduzir movimento" sem mexer no aparelho. No app, ficam no padrão.
 */
export interface UiPreferences {
  /** Multiplica o tamanho das fontes do `Text` (1 = sem simulação). */
  fontScale: number;
  /** `undefined` segue o sistema; `true`/`false` força o valor. */
  reduceMotion: boolean | undefined;
  /** Leitor de tela (VoiceOver/TalkBack): `undefined` segue o sistema. */
  screenReader: boolean | undefined;
}

const UiPreferencesContext = createContext<UiPreferences>({
  fontScale: 1,
  reduceMotion: undefined,
  screenReader: undefined,
});

export interface UiPreferencesProviderProps {
  fontScale?: number;
  reduceMotion?: boolean;
  screenReader?: boolean;
  children: ReactNode;
}

export function UiPreferencesProvider({
  fontScale = 1,
  reduceMotion,
  screenReader,
  children,
}: UiPreferencesProviderProps) {
  const value = useMemo(
    () => ({ fontScale, reduceMotion, screenReader }),
    [fontScale, reduceMotion, screenReader],
  );
  return <UiPreferencesContext.Provider value={value}>{children}</UiPreferencesContext.Provider>;
}

export function useFontScale(): number {
  return useContext(UiPreferencesContext).fontScale;
}

/** "Reduzir movimento": a simulação do catálogo tem prioridade sobre o sistema. */
export function useReducedMotion(): boolean {
  const { reduceMotion } = useContext(UiPreferencesContext);
  const [system, setSystem] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) {
          setSystem(enabled);
        }
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setSystem);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion ?? system;
}

/**
 * Leitor de tela ligado (VoiceOver/TalkBack): controles que somem sozinhos ficam fixos e aparecem os
 * botões explícitos (ReelViewer, WCAG 2.2.2). A simulação do catálogo tem prioridade sobre o sistema.
 */
export function useScreenReaderEnabled(): boolean {
  const { screenReader } = useContext(UiPreferencesContext);
  const [system, setSystem] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isScreenReaderEnabled()
      .then((enabled) => {
        if (mounted) {
          setSystem(enabled);
        }
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener('screenReaderChanged', setSystem);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return screenReader ?? system;
}
