import { render, type RenderOptions } from '@testing-library/react-native';
import type { ReactElement, ReactNode } from 'react';

import { UiPreferencesProvider } from '../preferences';

export interface RenderUiOptions extends RenderOptions {
  fontScale?: number;
  reduceMotion?: boolean;
  /** Simula o VoiceOver/TalkBack ligado. */
  screenReader?: boolean;
}

/** Render com as preferências do design system (escala de fonte, movimento e leitor de tela). */
export function renderUi(
  ui: ReactElement,
  { fontScale, reduceMotion, screenReader, ...options }: RenderUiOptions = {},
) {
  function Providers({ children }: { children: ReactNode }) {
    return (
      <UiPreferencesProvider
        {...(fontScale === undefined ? {} : { fontScale })}
        reduceMotion={reduceMotion ?? true}
        {...(screenReader === undefined ? {} : { screenReader })}
      >
        {children}
      </UiPreferencesProvider>
    );
  }
  return render(ui, { ...options, wrapper: Providers });
}
