import { Button, Text, theme, useToast } from '@sussurro/ui';
import { router } from 'expo-router';
import { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';

import { useAuth } from './AuthProvider';
import { errorMessage } from '../../lib/error-messages';
import { ROUTES } from '../navigation/routes';

export const VERIFY_EMAIL_ACTION = 'Verificar e-mail';

function openVerifyEmail() {
  router.push(ROUTES.verifyEmail);
}

/**
 * Publicar e comentar exigem e-mail confirmado (X.3): quando a API responde `EMAIL_NOT_VERIFIED`,
 * mostra a mensagem com a ação para a tela "Verificar e-mail" (que reenvia o link) e recarrega o
 * perfil, para o aviso fixo aparecer.
 */
export function useEmailNotVerified() {
  const toast = useToast();
  const { reloadUser } = useAuth();
  return useCallback(() => {
    toast.show({
      message: errorMessage('EMAIL_NOT_VERIFIED'),
      variant: 'error',
      action: { label: VERIFY_EMAIL_ACTION, onPress: openVerifyEmail },
    });
    void reloadUser().catch(() => undefined);
  }, [reloadUser, toast]);
}

/** Aviso fixo no Criar e nos comentários enquanto o e-mail não está confirmado (X.3). */
export function EmailNotVerifiedNotice({ testID = 'email-not-verified' }: { testID?: string }) {
  return (
    <View style={styles.notice} testID={testID}>
      <Text variant="bodySm" style={styles.flex}>
        {errorMessage('EMAIL_NOT_VERIFIED')}
      </Text>
      <Button variant="link" size="sm" label={VERIFY_EMAIL_ACTION} onPress={openVerifyEmail} />
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[8],
    paddingHorizontal: theme.space[12],
    paddingVertical: theme.space[4],
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.blueLight,
  },
  flex: { flex: 1 },
});
