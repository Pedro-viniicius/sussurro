import { StyleSheet, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

/** Opacidade do preto no rodapé do `mediaScrim` (ux.md §6.2: rgba(0,0,0,0) → rgba(0,0,0,0.45)). */
export const MEDIA_SCRIM_OPACITY = 0.45;

export interface MediaScrimProps {
  /** Parte de baixo coberta pelo gradiente (0 a 1); o padrão é 40% (ux.md §6.2). */
  coverage?: number;
  testID?: string;
}

/**
 * Gradiente `mediaScrim` sobre a miniatura ou o vídeo, para o texto branco (duração do reel, autor,
 * legenda) ficar legível sobre qualquer imagem clara (ux.md §7.1: branco sobre a miniatura creme do
 * p08 tem contraste ~1,3 sem o scrim). Decorativo: não entra no leitor de tela nem recebe toques.
 */
export function MediaScrim({ coverage = 0.4, testID = 'media-scrim' }: MediaScrimProps) {
  const height = `${Math.round(Math.max(0, Math.min(1, coverage)) * 100)}%` as const;
  return (
    <View
      testID={testID}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.scrim, { height }]}
    >
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id="mediaScrim" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#000000" stopOpacity={0} />
            <Stop offset="1" stopColor="#000000" stopOpacity={MEDIA_SCRIM_OPACITY} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#mediaScrim)" />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
