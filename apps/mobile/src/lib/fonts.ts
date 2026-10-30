import { BricolageGrotesque_800ExtraBold } from '@expo-google-fonts/bricolage-grotesque/800ExtraBold';
import { Inter_400Regular } from '@expo-google-fonts/inter/400Regular';
import { Inter_600SemiBold } from '@expo-google-fonts/inter/600SemiBold';
import { Inter_700Bold } from '@expo-google-fonts/inter/700Bold';
import { theme } from '@sussurro/ui/theme';
import { useFonts } from 'expo-font';

/**
 * Fontes do app (ux.md §6.5): Inter 400/600/700 e Bricolage Grotesque 800 só no wordmark.
 * Importadas peso a peso: o índice do pacote referencia todos os 18 arquivos da Inter, e o Metro
 * os colocaria no bundle (~6 MB). Cada peso é registrado com o nome de família que o
 * `theme.fonts` usa, igual no iOS e no Android. O splash segura a tela até elas carregarem.
 */
export const appFonts = {
  [theme.fonts.regular]: Inter_400Regular,
  [theme.fonts.semibold]: Inter_600SemiBold,
  [theme.fonts.bold]: Inter_700Bold,
  [theme.fonts.wordmark]: BricolageGrotesque_800ExtraBold,
};

export function useAppFonts(): [loaded: boolean, error: Error | null] {
  return useFonts(appFonts);
}
