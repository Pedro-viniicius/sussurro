import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { Avatar } from '../Avatar/Avatar';
import { Icon } from '../Icon/Icon';

export interface PairPerson {
  handle: string;
  name?: string;
  uri?: string | null;
  seed?: string;
}

export interface PairAvatarsProps {
  left: PairPerson;
  right: PairPerson;
  /**
   * `waiting` (p13): dois Avatar 64 com o tracejado azul entre eles. `notConfirmed`: o mesmo, com
   * o tracejado cinza (ux.md §5.2). `connected` (p14): dois Avatar 72 sobrepostos com o selo ✓.
   */
  state: 'waiting' | 'notConfirmed' | 'connected';
  testID?: string;
}

const DOTS = 6;

function PairAvatar({ person, size }: { person: PairPerson; size: 64 | 72 }) {
  return (
    <Avatar
      size={size}
      handle={person.handle}
      {...(person.name === undefined ? {} : { name: person.name })}
      {...(person.seed === undefined ? {} : { seed: person.seed })}
      {...(person.uri === undefined ? {} : { uri: person.uri })}
      decorative
    />
  );
}

/** Par de avatares das telas "Aguardando" e "Conectados" (ux.md §6.14). Decorativo: o texto diz. */
export function PairAvatars({ left, right, state, testID = 'pair-avatars' }: PairAvatarsProps) {
  const hidden = {
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants' as const,
  };

  if (state === 'connected') {
    return (
      <View testID={testID} style={styles.row} {...hidden}>
        <PairAvatar person={left} size={72} />
        <View style={styles.overlap}>
          <PairAvatar person={right} size={72} />
        </View>
        <View style={styles.badge} testID={`${testID}-selo`}>
          <Icon name="check" size={16} color="white" active />
        </View>
      </View>
    );
  }

  const dotColor = state === 'waiting' ? theme.colors.blue : theme.colors.grey;
  return (
    <View testID={testID} style={styles.row} {...hidden}>
      <PairAvatar person={left} size={64} />
      <View style={styles.dots} testID={`${testID}-${state === 'waiting' ? 'azul' : 'cinza'}`}>
        {Array.from({ length: DOTS }, (_, index) => (
          <View key={index} style={[styles.dot, { backgroundColor: dotColor }]} />
        ))}
      </View>
      <PairAvatar person={right} size={64} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  overlap: { marginLeft: -16 },
  badge: {
    position: 'absolute',
    bottom: -8,
    alignSelf: 'center',
    left: '50%',
    marginLeft: -14,
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 3,
    borderColor: theme.colors.white,
    backgroundColor: theme.colors.blue,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: theme.space[8],
  },
  dot: { width: 4, height: 4, borderRadius: 2 },
});
