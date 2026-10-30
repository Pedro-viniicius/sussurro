import { Image } from 'expo-image';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { theme } from '../../theme';
import { Icon } from '../Icon/Icon';
import { Text } from '../Text/Text';

export interface PickerItem {
  key: string;
  uri: string;
}

export interface MediaPickerGridProps {
  items: readonly PickerItem[];
  /** Chaves selecionadas, na ordem da seleção (o número 1–4 no círculo azul). */
  selected: readonly string[];
  onToggle: (key: string) => void;
  /** Primeiro quadrado: abre o seletor do sistema. */
  onAdd?: () => void;
  addLabel?: string;
  /** Largura da grade; padrão: a largura da tela. */
  width?: number;
  testID?: string;
}

const COLUMNS = 4;
const SELECTOR = 22;

/**
 * Grade do Criar (p18, ux.md §6.14): 4 colunas 1:1 com gap 2; seletor de 22 (anel branco sobre preto
 * 20%); selecionado = círculo azul com o número. A regra das 4 fotos e o Toast ficam no app.
 */
export function MediaPickerGrid({
  items,
  selected,
  onToggle,
  onAdd,
  addLabel = 'Escolher',
  width,
  testID = 'media-picker',
}: MediaPickerGridProps) {
  const window = useWindowDimensions();
  const total = width ?? window.width;
  const gap = theme.layout.gridGap;
  const size = Math.floor((total - gap * (COLUMNS - 1)) / COLUMNS);

  return (
    <View testID={testID} style={[styles.grid, { gap }]}>
      {onAdd === undefined ? null : (
        <Pressable
          testID={`${testID}-add`}
          accessibilityRole="button"
          accessibilityLabel="Escolher fotos do aparelho"
          onPress={onAdd}
          style={({ pressed }) => [
            styles.add,
            { width: size, height: size },
            pressed && styles.pressed,
          ]}
        >
          <Icon name="image-plus" size={theme.size.icon.lg} color="greyStrong" />
          <Text variant="caption" color="greyStrong">
            {addLabel}
          </Text>
        </Pressable>
      )}
      {items.map((item, index) => {
        const order = selected.indexOf(item.key);
        const isSelected = order >= 0;
        return (
          <Pressable
            key={item.key}
            testID={`${testID}-item-${index}`}
            accessibilityRole="button"
            accessibilityLabel={
              isSelected ? `Foto ${index + 1}, ${order + 1}ª selecionada` : `Foto ${index + 1}`
            }
            accessibilityState={{ selected: isSelected }}
            onPress={() => {
              onToggle(item.key);
            }}
            style={{ width: size, height: size }}
          >
            <Image
              source={{ uri: item.uri }}
              contentFit="cover"
              accessible={false}
              style={StyleSheet.absoluteFill}
            />
            <View style={[styles.selector, isSelected ? styles.selectorOn : styles.selectorOff]}>
              {isSelected ? (
                <Text variant="micro" color="white" maxFontSizeMultiplier={1}>
                  {order + 1}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  add: {
    backgroundColor: theme.colors.greySoft,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[4],
  },
  pressed: { opacity: theme.opacity.pressed },
  selector: {
    position: 'absolute',
    top: 6,
    right: 6,
    width: SELECTOR,
    height: SELECTOR,
    borderRadius: SELECTOR / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectorOff: {
    borderWidth: 1.5,
    borderColor: theme.colors.white,
    backgroundColor: 'rgba(0,0,0,0.2)',
  },
  selectorOn: { backgroundColor: theme.colors.blue },
});
