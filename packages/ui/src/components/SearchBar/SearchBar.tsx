import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useFontScale } from '../../preferences';
import { theme } from '../../theme';
import { Icon } from '../Icon/Icon';

export interface SearchBarProps {
  value: string;
  onChangeText: (value: string) => void;
  /** Padrão: "Pesquisar @criador" (p15). */
  placeholder?: string;
  /** Busca em andamento: spinner de 20 no fim da barra (ux.md §5.1). */
  loading?: boolean;
  autoFocus?: boolean;
  onSubmitEditing?: () => void;
  testID?: string;
}

export const SEARCH_PLACEHOLDER = 'Pesquisar @criador';

/**
 * Barra de busca (p15, ux.md §6.14): altura mínima 36, fundo greySoft, raio 10, lupa 18 e
 * "limpar" (`circle-x`) quando há texto. Sem correção automática nem maiúsculas: o @ é minúsculo.
 * O prefixo "@" é aceito; quem usa a barra normaliza o termo antes de buscar.
 */
export function SearchBar({
  value,
  onChangeText,
  placeholder = SEARCH_PLACEHOLDER,
  loading = false,
  autoFocus = false,
  onSubmitEditing,
  testID = 'search-bar',
}: SearchBarProps) {
  const fontScale = useFontScale();
  return (
    <View style={styles.bar} testID={testID}>
      <Icon name="search" size={18} color="greyStrong" />
      <TextInput
        testID={`${testID}-input`}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.colors.greyStrong}
        accessibilityLabel={placeholder}
        accessibilityRole="search"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        returnKeyType="search"
        autoFocus={autoFocus}
        {...(onSubmitEditing === undefined ? {} : { onSubmitEditing })}
        maxFontSizeMultiplier={theme.type.bodyLg.maxFontSizeMultiplier}
        style={[
          styles.input,
          {
            fontFamily: theme.fonts.regular,
            fontSize: theme.type.bodyLg.fontSize * fontScale,
            color: theme.colors.black,
          },
        ]}
      />
      {loading ? (
        <ActivityIndicator
          testID={`${testID}-loading`}
          size="small"
          color={theme.colors.grey}
          accessibilityLabel="Buscando"
        />
      ) : value === '' ? null : (
        <Pressable
          testID={`${testID}-clear`}
          accessibilityRole="button"
          accessibilityLabel="Limpar busca"
          hitSlop={12}
          onPress={() => {
            onChangeText('');
          }}
        >
          <Icon name="circle-x" size={18} color="greyStrong" />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    minHeight: theme.size.searchBar,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[8],
    paddingHorizontal: theme.space[12],
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.greySoft,
  },
  input: { flex: 1, paddingVertical: theme.space[6], paddingHorizontal: 0 },
});
