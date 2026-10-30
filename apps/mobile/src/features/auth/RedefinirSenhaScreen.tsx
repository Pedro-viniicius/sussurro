import {
  isWeakPassword,
  NoContentSchema,
  PASSWORD_MAX_LENGTH,
  passwordLength,
} from '@sussurro/shared';
import { Button, EmptyState, Input, theme, useToast } from '@sussurro/ui';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AuthLayout, FormError } from './AuthLayout';
import { useAuth } from './AuthProvider';
import { isApiError, NetworkError } from '../../lib/api/errors';
import { errorMessage, messageForError, OFFLINE_MESSAGE } from '../../lib/error-messages';
import { ROUTES } from '../navigation/routes';

export const PASSWORD_CHANGED_MESSAGE = 'Senha alterada. Entre com a nova senha.';

/**
 * Redefinir senha (história 1.10), aberta pelo link do e-mail (`sussurro://redefinir-senha?token=`).
 * Trocar a senha revoga todas as sessões, inclusive a deste aparelho.
 */
export function RedefinirSenhaScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { api, endLocalSession, status } = useAuth();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [invalidLink, setInvalidLink] = useState(token === undefined || token === '');
  const [loading, setLoading] = useState(false);

  const requestNewLink = () => {
    router.replace(ROUTES.forgotPassword);
  };

  if (invalidLink || token === undefined) {
    return (
      <SafeAreaView style={styles.screen}>
        <EmptyState
          icon="circle-alert"
          title="Link inválido"
          description={errorMessage('INVALID_TOKEN')}
          primaryAction={{ label: 'Pedir um novo link', onPress: requestNewLink }}
        />
      </SafeAreaView>
    );
  }

  const submit = async () => {
    setFormError(undefined);
    if (passwordLength(password) > PASSWORD_MAX_LENGTH) {
      setError(`Use no máximo ${String(PASSWORD_MAX_LENGTH)} caracteres.`);
      return;
    }
    if (isWeakPassword(password)) {
      setError(errorMessage('WEAK_PASSWORD'));
      return;
    }
    setError(undefined);
    setLoading(true);
    try {
      await api.request('/v1/auth/password/reset', {
        method: 'POST',
        body: { token, password },
        schema: NoContentSchema,
        auth: false,
      });
      if (status === 'signedIn') {
        await endLocalSession();
      }
      toast.show({ message: PASSWORD_CHANGED_MESSAGE, variant: 'success' });
      router.replace(ROUTES.signIn);
    } catch (caught) {
      if (caught instanceof NetworkError) {
        toast.show({ message: OFFLINE_MESSAGE, variant: 'error' });
      } else if (isApiError(caught, 'INVALID_TOKEN')) {
        setInvalidLink(true);
      } else if (isApiError(caught, 'WEAK_PASSWORD')) {
        setError(errorMessage('WEAK_PASSWORD'));
      } else {
        setFormError(messageForError(caught));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout intro="Escolha uma senha nova. Você vai sair de todos os aparelhos.">
      <Input
        label="Nova senha"
        type="password"
        passwordPurpose="new"
        value={password}
        onChangeText={setPassword}
        testID="nova-senha"
        {...(error === undefined ? {} : { error })}
      />
      <Button
        label="Salvar senha"
        fullWidth
        loading={loading}
        onPress={() => {
          void submit();
        }}
      />
      <FormError message={formError} />
    </AuthLayout>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
});
