import { StyleSheet, View } from 'react-native';

import { theme } from '../../theme';
import { Button } from '../Button/Button';
import { Icon, type IconName } from '../Icon/Icon';
import { Text } from '../Text/Text';

export interface EmptyStateAction {
  label: string;
  onPress: () => void;
}

export interface EmptyStateProps {
  icon: IconName;
  title: string;
  description?: string;
  primaryAction?: EmptyStateAction;
  /** Link abaixo do botão primário. */
  secondaryAction?: EmptyStateAction;
  testID?: string;
}

/** Estado vazio ou bloqueado (p22, ux.md §6.13). */
export function EmptyState({
  icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  testID = 'empty-state',
}: EmptyStateProps) {
  return (
    <View testID={testID} style={styles.container}>
      <View style={styles.circle}>
        <Icon name={icon} size={theme.size.icon.lg} />
      </View>
      <Text variant="titleMd" align="center" accessibilityRole="header" style={styles.title}>
        {title}
      </Text>
      {description === undefined ? null : (
        <Text variant="bodySm" color="grey" align="center" style={styles.description}>
          {description}
        </Text>
      )}
      {primaryAction === undefined ? null : (
        <View style={styles.primary}>
          <Button size="sm" label={primaryAction.label} onPress={primaryAction.onPress} />
        </View>
      )}
      {secondaryAction === undefined ? null : (
        <View style={styles.secondary}>
          <Button
            variant="link"
            size="sm"
            label={secondaryAction.label}
            onPress={secondaryAction.onPress}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingTop: theme.space[64],
    paddingHorizontal: theme.layout.screenX,
  },
  circle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 2,
    borderColor: theme.colors.black,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { marginTop: theme.space[16] },
  description: { marginTop: theme.space[6], maxWidth: 320 },
  primary: { marginTop: theme.space[16] },
  secondary: { marginTop: theme.space[12] },
});
