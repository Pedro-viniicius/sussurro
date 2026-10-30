import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { Icon } from '../Icon/Icon';
import { Text } from '../Text/Text';

export interface OfflineBannerProps {
  /** `offline`: "Sem internet". `back`: "Conectado" (some sozinho depois de 1,5 s, no app). */
  status: 'offline' | 'back';
  testID?: string;
}

/** Faixa fina sob o header (ux.md §5.4): fundo ink, texto branco 13/600. */
export function OfflineBanner({ status, testID = 'offline-banner' }: OfflineBannerProps) {
  const offline = status === 'offline';
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={styles.banner}
    >
      <Icon name={offline ? 'wifi-off' : 'check'} size={14} color="white" />
      <Text variant="micro" color="white">
        {offline ? 'Sem internet' : 'Conectado'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space[6],
    paddingVertical: theme.space[6],
    backgroundColor: theme.colors.ink,
  },
});
