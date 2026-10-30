import { Pressable, StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { Avatar } from '../Avatar/Avatar';
import { Button } from '../Button/Button';
import { Icon, type IconName } from '../Icon/Icon';
import { STAT_LABELS, type StatItem, StatsRow } from '../StatsRow/StatsRow';
import { Text } from '../Text/Text';

export type ProfileHeaderCounts =
  | { accountType: 'personal'; posts: number; connections: number; creators: number }
  | { accountType: 'creator'; posts: number; followers: number };

interface ProfileHeaderBase {
  handle: string;
  name: string;
  bio: string | null;
  counts: ProfileHeaderCounts;
  avatarUri?: string | null;
  /** Semente da cor do avatar (id da conta). */
  avatarSeed?: string;
  testID?: string;
}

/** Perfil próprio (p16, p19). */
export interface ProfileHeaderSelfProps extends ProfileHeaderBase {
  mode?: 'self';
  onCreate: () => void;
  onSignOut: () => void;
  onEditProfile: () => void;
  /** Pessoal: "Conectar ao vivo". Criador: "Nova publicação". */
  onPrimaryAction: () => void;
  /** Listas privadas (Fases 3 e 4): só tocáveis quando a tela existir. */
  onOpenConnections?: () => void;
  onOpenCreators?: () => void;
}

/** Botão Seguir/Seguindo do criador visto por pessoa (p17). */
export interface ProfileFollowButton {
  following: boolean;
  onPress: () => void;
}

/**
 * Perfil de outra conta (criador visto por pessoa, p17, ou conexão, ux.md §4.9): `‹` + @ no topo,
 * números nunca tocáveis (as listas são privadas), o menu ⋯ (D-UX14) e, no criador visto por
 * pessoa, [Seguir] / (Seguindo) com a largura toda; na conexão, (Conectados ✓), que abre as opções
 * ("Desfazer conexão", D8).
 */
export interface ProfileHeaderOtherProps extends ProfileHeaderBase {
  mode: 'other';
  onBack: () => void;
  /** Menu ⋯ ("Denunciar", "Bloquear"). */
  onMore?: () => void;
  /** Só no criador visto por pessoa. */
  follow?: ProfileFollowButton;
  /** Só no perfil de uma conexão (pessoa vista por pessoa, ux.md §4.9). */
  connection?: { onPress: () => void };
}

/** Rótulo do botão "Conectados" para o leitor de tela. */
export function connectionButtonLabel(handle: string): string {
  return `Conectados com @${handle}, toque para ver as opções`;
}

/** Rótulos do botão de seguir para o leitor de tela (ux.md §6.13 Button). */
export function followButtonLabel(handle: string, following: boolean): string {
  return following ? `Seguindo @${handle}, toque para deixar de seguir` : `Seguir @${handle}`;
}

export type ProfileHeaderProps = ProfileHeaderSelfProps | ProfileHeaderOtherProps;

/** Nota de privacidade do perfil pessoal próprio (p16). */
export const PRIVACY_NOTE =
  'Só os números são públicos. Quem são suas conexões e criadores fica privado.';

function HeaderIcon({
  name,
  label,
  onPress,
}: {
  name: IconName;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
    >
      <Icon name={name} />
    </Pressable>
  );
}

function statsFor(props: ProfileHeaderProps): StatItem[] {
  const { counts } = props;
  const self = props.mode !== 'other';
  if (counts.accountType === 'creator') {
    return [
      { value: counts.posts, label: STAT_LABELS.posts },
      // Seguidores não têm lista nem para o dono (ADR 0004): nunca tocável.
      { value: counts.followers, label: STAT_LABELS.followers },
    ];
  }
  const onConnections = self ? props.onOpenConnections : undefined;
  const onCreators = self ? props.onOpenCreators : undefined;
  return [
    { value: counts.posts, label: STAT_LABELS.posts },
    {
      value: counts.connections,
      label: STAT_LABELS.connections,
      ...(onConnections === undefined ? {} : { onPress: onConnections }),
    },
    {
      value: counts.creators,
      label: STAT_LABELS.creators,
      ...(onCreators === undefined ? {} : { onPress: onCreators }),
    },
  ];
}

/** Cabeçalho do perfil (p16, p17, p19, ux.md §6.13). */
export function ProfileHeader(props: ProfileHeaderProps) {
  const { handle, name, bio, counts, avatarUri, avatarSeed, testID = 'profile-header' } = props;
  const personal = counts.accountType === 'personal';
  const self = props.mode !== 'other';

  return (
    <View testID={testID}>
      {props.mode === 'other' ? (
        <View style={[styles.topBar, styles.topBarBack]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Voltar"
            hitSlop={8}
            onPress={props.onBack}
            style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
          >
            <Icon name="chevron-left" />
          </Pressable>
          <Text variant="titleLg" accessibilityRole="header" numberOfLines={1} style={styles.flex}>
            {handle}
          </Text>
          {props.onMore === undefined ? null : (
            <HeaderIcon name="ellipsis" label="Mais opções" onPress={props.onMore} />
          )}
        </View>
      ) : (
        <View style={styles.topBar}>
          <Text variant="titleLg" accessibilityRole="header" numberOfLines={1} style={styles.flex}>
            {handle}
          </Text>
          <HeaderIcon name="square-plus" label="Criar publicação" onPress={props.onCreate} />
          <HeaderIcon name="log-out" label="Sair da conta" onPress={props.onSignOut} />
        </View>
      )}

      <View style={styles.body}>
        <View style={styles.row}>
          <Avatar
            size={theme.size.avatar.profile}
            handle={handle}
            name={name}
            {...(avatarSeed === undefined ? {} : { seed: avatarSeed })}
            {...(avatarUri === undefined ? {} : { uri: avatarUri })}
            decorative
          />
          <View style={styles.flex}>
            <StatsRow items={statsFor(props)} testID={`${testID}-stats`} />
          </View>
        </View>

        <View style={styles.texts}>
          <Text variant="bodyStrong">{name}</Text>
          <Text variant="bodySm" color="grey">
            {personal ? 'Conta pessoal' : 'Criador de conteúdo · não segue ninguém'}
          </Text>
          {bio === null ? null : <Text variant="body">{bio}</Text>}
          {personal && self ? (
            <Text variant="caption" color="grey" style={styles.note}>
              {PRIVACY_NOTE}
            </Text>
          ) : null}
        </View>

        {props.mode === 'other' ? (
          props.connection !== undefined ? (
            <Button
              testID={`${testID}-connection`}
              variant="secondary"
              size="sm"
              fullWidth
              icon="check"
              label="Conectados"
              accessibilityLabel={connectionButtonLabel(handle)}
              onPress={props.connection.onPress}
            />
          ) : props.follow === undefined ? null : (
            <Button
              testID={`${testID}-follow`}
              variant={props.follow.following ? 'secondary' : 'primary'}
              size="sm"
              fullWidth
              label={props.follow.following ? 'Seguindo' : 'Seguir'}
              accessibilityLabel={followButtonLabel(handle, props.follow.following)}
              onPress={props.follow.onPress}
            />
          )
        ) : (
          <View style={styles.buttons}>
            <View style={styles.flex}>
              <Button
                variant="secondary"
                size="sm"
                fullWidth
                label="Editar perfil"
                onPress={props.onEditProfile}
              />
            </View>
            <View style={styles.flex}>
              <Button
                variant={personal ? 'secondary' : 'primary'}
                size="sm"
                fullWidth
                label={personal ? 'Conectar ao vivo' : 'Nova publicação'}
                onPress={props.onPrimaryAction}
              />
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    height: theme.layout.headerHeight,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: theme.layout.screenX,
    paddingRight: theme.space[4],
  },
  topBarBack: { paddingLeft: theme.space[4], gap: theme.space[4] },
  iconButton: {
    width: theme.layout.hitMin,
    height: theme.layout.hitMin,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: theme.opacity.pressed },
  body: { paddingHorizontal: theme.layout.screenX, gap: theme.space[12] },
  row: { flexDirection: 'row', alignItems: 'center', gap: theme.space[16] },
  flex: { flex: 1 },
  texts: { gap: 2 },
  note: { marginTop: theme.space[4] },
  buttons: { flexDirection: 'row', gap: theme.space[8] },
});
