import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { type AvatarSize, theme } from '../../theme';
import { Avatar } from '../Avatar/Avatar';
import { Text } from '../Text/Text';

export interface UserRowProps {
  handle: string;
  name?: string;
  /** Linha cinza abaixo do @ (ex.: "Estúdio Aurora · 5.067 seguidores"). */
  subtitle?: string;
  avatarUri?: string | null;
  /** Semente da cor do avatar sem foto. */
  seed?: string;
  /** Toque na linha (avatar e textos): abre o perfil. Sem ele, a linha não é tocável. */
  onPress?: () => void;
  /** Ação à direita, fora da área tocável da linha (ex.: Seguir/Seguindo, Desbloquear). */
  action?: ReactNode;
  /** 44 nas listas; 48 em "Por perto agora" (ux.md §6.8). */
  avatarSize?: AvatarSize;
  testID?: string;
}

/**
 * Linha de conta (busca, listas próprias e bloqueados; ux.md §6.14): Avatar 44, @ `bodyStrong`,
 * subtítulo `bodySm` grey e uma ação à direita. Altura mínima 64.
 */
export function UserRow({
  handle,
  name,
  subtitle,
  avatarUri,
  seed,
  onPress,
  action,
  avatarSize = theme.size.avatar.lg,
  testID = `user-row-${handle}`,
}: UserRowProps) {
  const label = subtitle === undefined ? `@${handle}` : `@${handle}, ${subtitle}`;
  const content = (
    <>
      <Avatar
        size={avatarSize}
        handle={handle}
        {...(name === undefined ? {} : { name })}
        {...(seed === undefined ? {} : { seed })}
        {...(avatarUri === undefined ? {} : { uri: avatarUri })}
        decorative
      />
      <View style={styles.texts}>
        <Text variant="bodyStrong" numberOfLines={1}>
          {handle}
        </Text>
        {subtitle === undefined ? null : (
          <Text variant="bodySm" color="grey" numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
    </>
  );
  return (
    <View style={styles.row} testID={testID}>
      {onPress === undefined ? (
        <View style={styles.main} accessible accessibilityLabel={label}>
          {content}
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityHint="Abre o perfil"
          onPress={onPress}
          style={({ pressed }) => [styles.main, pressed && styles.pressed]}
        >
          {content}
        </Pressable>
      )}
      {action === undefined ? null : <View style={styles.action}>{action}</View>}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: theme.layout.rowMinHeight,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.layout.screenX,
    gap: theme.space[12],
  },
  main: {
    flex: 1,
    minHeight: theme.layout.hitMin,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[12],
  },
  texts: { flex: 1, gap: 2 },
  action: { flexShrink: 0 },
  pressed: { opacity: theme.opacity.pressed },
});
