import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';

import { useReducedMotion } from '../../preferences';
import { theme } from '../../theme';
import { Icon, type IconName } from '../Icon/Icon';
import { Text } from '../Text/Text';

export interface TopTab<K extends string = string> {
  key: K;
  label?: string;
  icon?: IconName;
  /** Obrigatório: nas abas com ícone é o único texto que o leitor de tela lê. */
  accessibilityLabel: string;
}

export interface TopTabsProps<K extends string = string> {
  tabs: readonly TopTab<K>[];
  value: K;
  onChange: (key: K) => void;
  /** `text`: feed (Fotos/Textos/Reels, sublinhado azul). `icon`: perfil (sublinhado preto). */
  variant?: 'text' | 'icon';
  testID?: string;
}

export function TopTabs<K extends string>({
  tabs,
  value,
  onChange,
  variant = 'text',
  testID = 'top-tabs',
}: TopTabsProps<K>) {
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    tabs.findIndex((tab) => tab.key === value),
  );
  const tabWidth = tabs.length > 0 ? width / tabs.length : 0;
  const [translateX] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(translateX, {
      toValue: index * tabWidth,
      duration: reduceMotion ? 0 : theme.motion.base,
      easing: Easing.bezier(...theme.motion.easing),
      useNativeDriver: true,
    }).start();
  }, [index, tabWidth, reduceMotion, translateX]);

  const indicatorColor = variant === 'text' ? theme.colors.blue : theme.colors.black;

  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      style={styles.container}
      onLayout={(event) => {
        setWidth(event.nativeEvent.layout.width);
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.key === value;
        return (
          <Pressable
            key={tab.key}
            testID={`${testID}-${tab.key}`}
            accessibilityRole="tab"
            accessibilityLabel={tab.accessibilityLabel}
            accessibilityState={{ selected }}
            onPress={() => {
              if (!selected) {
                onChange(tab.key);
              }
            }}
            style={styles.tab}
          >
            {variant === 'icon' && tab.icon !== undefined ? (
              <Icon name={tab.icon} color={selected ? 'black' : 'grey'} />
            ) : (
              <Text variant="tab" color={selected ? 'black' : 'grey'}>
                {tab.label ?? tab.accessibilityLabel}
              </Text>
            )}
          </Pressable>
        );
      })}
      <Animated.View
        testID={`${testID}-indicator`}
        pointerEvents="none"
        style={[
          styles.indicator,
          { width: tabWidth, backgroundColor: indicatorColor, transform: [{ translateX }] },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    minHeight: theme.layout.topTabsHeight,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.colors.border,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: theme.layout.topTabsHeight,
  },
  indicator: {
    position: 'absolute',
    left: 0,
    bottom: 0,
    height: theme.size.tabIndicator,
  },
});
