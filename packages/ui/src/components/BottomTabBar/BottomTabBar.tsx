import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { theme } from '../../theme';
import { Avatar } from '../Avatar/Avatar';
import { Icon } from '../Icon/Icon';

export type PersonalTabKey = 'home' | 'search' | 'create' | 'connect' | 'profile';
export type CreatorTabKey = 'notifications' | 'create' | 'profile';
export type BottomTabKey = PersonalTabKey | CreatorTabKey;

export interface BottomTabBarProps {
  /** Pessoal: Início, Pesquisar, Criar, Conectar, Perfil. Criador: Notificações, Criar, Perfil. */
  variant: 'personal' | 'creator';
  active: BottomTabKey;
  avatar: { handle: string; name?: string; seed?: string; uri?: string | null };
  /** Ponto azul em Notificações (só criador). */
  hasUnread?: boolean;
  onPress: (key: BottomTabKey) => void;
  testID?: string;
}

const ORDER = {
  personal: ['home', 'search', 'create', 'connect', 'profile'],
  creator: ['notifications', 'create', 'profile'],
} as const satisfies Record<'personal' | 'creator', readonly BottomTabKey[]>;

const LABELS: Record<BottomTabKey, string> = {
  home: 'Início',
  search: 'Pesquisar',
  create: 'Criar publicação',
  connect: 'Conectar',
  profile: 'Perfil',
  notifications: 'Notificações',
};

export function bottomTabOrder(variant: 'personal' | 'creator'): readonly BottomTabKey[] {
  return ORDER[variant];
}

export function BottomTabBar({
  variant,
  active,
  avatar,
  hasUnread = false,
  onPress,
  testID = 'bottom-tab-bar',
}: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  const renderGlyph = (key: BottomTabKey, selected: boolean) => {
    switch (key) {
      case 'home':
        return <Icon name="house" active={selected} />;
      case 'search':
        return <Icon name="search" active={selected} />;
      case 'create':
        return <Icon name="square-plus" />;
      case 'connect':
        // Exceção do protótipo (D-UX8): Conectar ativo em azul.
        return <Icon name="radio" active={selected} color={selected ? 'blue' : 'black'} />;
      case 'notifications':
        return (
          <View>
            <Icon name="heart" filled={selected} />
            {hasUnread ? <View testID={`${testID}-unread`} style={styles.unread} /> : null}
          </View>
        );
      case 'profile':
        return <Avatar size={24} {...avatar} ring={selected} decorative />;
    }
  };

  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      style={[styles.bar, { paddingBottom: insets.bottom }]}
    >
      {ORDER[variant].map((key) => {
        const selected = key === active;
        const label =
          key === 'notifications' && hasUnread ? `${LABELS[key]}, há novidades` : LABELS[key];
        return (
          <Pressable
            key={key}
            testID={`${testID}-${key}`}
            accessibilityRole="tab"
            accessibilityLabel={label}
            accessibilityState={{ selected }}
            accessibilityShowsLargeContentViewer
            accessibilityLargeContentTitle={LABELS[key]}
            onPress={() => {
              onPress(key);
            }}
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
          >
            {renderGlyph(key, selected)}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: theme.colors.white,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  item: {
    flex: 1,
    height: theme.layout.bottomBarHeight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: theme.opacity.pressed },
  unread: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: theme.size.unreadDot,
    height: theme.size.unreadDot,
    borderRadius: theme.size.unreadDot / 2,
    backgroundColor: theme.colors.blue,
    borderWidth: 1.5,
    borderColor: theme.colors.white,
  },
});
