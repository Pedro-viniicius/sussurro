import { Image } from 'expo-image';
import { type AccessibilityActionEvent, Pressable, StyleSheet, View } from 'react-native';

import { useReducedMotion } from '../../preferences';
import { theme } from '../../theme';
import { Avatar } from '../Avatar/Avatar';
import { Text } from '../Text/Text';

/**
 * Um pedaço do texto (o mesmo formato do `notificationTextParts` do `packages/shared`, que o
 * `packages/ui` não importa): o @ em 600 (tocável com `onPressHandle`), o "N novas pessoas" dos
 * seguidores agregados em 600 (nunca tocável: não há ninguém nomeado, p21), texto comum ou o
 * trecho do comentário entre aspas.
 */
export interface NotificationTextSegment {
  kind: 'handle' | 'count' | 'text' | 'quote';
  value: string;
}

export type NotificationRowAvatar =
  | { kind: 'account'; handle: string; name?: string; seed?: string; uri?: string | null }
  /** Seguidores agregados (p21): "+N" sobre `blueLight`, sem ninguém nomeado. */
  | { kind: 'aggregate'; count: number; label: string };

export interface NotificationRowProps {
  parts: readonly NotificationTextSegment[];
  /** Tempo curto, inline depois do texto ("20 min", "3 h", "ontem", "2 d"). */
  time: string;
  avatar: NotificationRowAvatar;
  /** Miniatura do post (foto ou capa do reel). Texto e sem post: sem miniatura. */
  thumbnail?: { key: string; uri: string } | null;
  /** Ponto azul 8 à esquerda da miniatura (ux.md §6.14, proposta). */
  unread?: boolean;
  /** Toque na linha: abre o post (ou o perfil, em "conectados"). Sem ele, a linha não é botão. */
  onPress?: () => void;
  /** Toque no @: só existe quando o perfil é visível para quem lê (D11/A-07). */
  onPressHandle?: () => void;
  /** Texto inteiro, para o leitor de tela (o app junta o tempo e o "não lida"). */
  accessibilityLabel: string;
  accessibilityHint?: string;
  /** Ação do leitor de tela para o @ tocável (ex.: "Abrir o perfil de @marinac"). */
  handleActionLabel?: string;
  testID?: string;
}

const THUMB_SIZE = 44;
const PROFILE_ACTION = 'profile';

/**
 * Linha de notificação (p09, p21; ux.md §6.14): Avatar 44 (ou o "+N" agregado), texto `body` com o
 * @ (ou o "N novas pessoas") em 600 e o tempo inline em `caption` grey, miniatura 44 com raio 6 à
 * direita e o ponto azul das não lidas.
 */
export function NotificationRow({
  parts,
  time,
  avatar,
  thumbnail,
  unread = false,
  onPress,
  onPressHandle,
  accessibilityLabel,
  accessibilityHint,
  handleActionLabel,
  testID = 'notification-row',
}: NotificationRowProps) {
  const reduceMotion = useReducedMotion();

  const content = (
    <>
      {avatar.kind === 'aggregate' ? (
        <Avatar
          size={theme.size.avatar.lg}
          handle=""
          count={avatar.count}
          countLabel={avatar.label}
          decorative
          testID={`${testID}-avatar`}
        />
      ) : (
        <Avatar
          size={theme.size.avatar.lg}
          handle={avatar.handle}
          {...(avatar.name === undefined ? {} : { name: avatar.name })}
          {...(avatar.seed === undefined ? {} : { seed: avatar.seed })}
          {...(avatar.uri === undefined ? {} : { uri: avatar.uri })}
          decorative
          testID={`${testID}-avatar`}
        />
      )}
      <View style={styles.texts}>
        <Text variant="body">
          {parts.map((part, index) => {
            switch (part.kind) {
              case 'handle':
                return (
                  <Text
                    key={index}
                    variant="bodyStrong"
                    testID={`${testID}-handle`}
                    {...(onPressHandle === undefined
                      ? {}
                      : { onPress: onPressHandle, suppressHighlighting: true })}
                  >
                    {part.value}
                  </Text>
                );
              case 'count':
                return (
                  <Text key={index} variant="bodyStrong" testID={`${testID}-count`}>
                    {part.value}
                  </Text>
                );
              case 'text':
              case 'quote':
                return (
                  <Text key={index} variant="body">
                    {part.value}
                  </Text>
                );
            }
          })}
          <Text variant="caption" color="grey">
            {` ${time}`}
          </Text>
        </Text>
      </View>
      {unread ? <View testID={`${testID}-unread`} style={styles.unread} /> : null}
      {thumbnail === undefined || thumbnail === null ? null : (
        <View style={styles.thumb} testID={`${testID}-thumb`}>
          <Image
            source={{ uri: thumbnail.uri, cacheKey: thumbnail.key }}
            recyclingKey={thumbnail.key}
            cachePolicy="memory-disk"
            contentFit="cover"
            transition={reduceMotion ? 0 : 150}
            accessible={false}
            style={StyleSheet.absoluteFill}
          />
        </View>
      )}
    </>
  );

  const actions =
    onPressHandle === undefined
      ? undefined
      : [{ name: PROFILE_ACTION, label: handleActionLabel ?? 'Abrir o perfil' }];
  const onAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === PROFILE_ACTION) onPressHandle?.();
    if (event.nativeEvent.actionName === 'activate') onPress?.();
  };
  const a11y = {
    accessibilityLabel,
    ...(accessibilityHint === undefined ? {} : { accessibilityHint }),
    ...(actions === undefined
      ? {}
      : {
          accessibilityActions:
            onPress === undefined ? actions : [{ name: 'activate' }, ...actions],
          onAccessibilityAction: onAction,
        }),
  };

  if (onPress === undefined) {
    return (
      <View testID={testID} style={styles.row} accessible {...a11y}>
        {content}
      </View>
    );
  }
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      {...a11y}
    >
      {content}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: theme.layout.rowMinHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[12],
    paddingHorizontal: theme.layout.screenX,
    paddingVertical: theme.space[8],
  },
  texts: { flex: 1 },
  unread: {
    width: theme.size.unreadDot,
    height: theme.size.unreadDot,
    borderRadius: theme.size.unreadDot / 2,
    backgroundColor: theme.colors.blue,
  },
  thumb: {
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: theme.radius.sm,
    overflow: 'hidden',
    backgroundColor: theme.colors.greySoft,
  },
  pressed: { opacity: theme.opacity.pressed },
});
