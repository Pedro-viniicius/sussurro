import { Button, Input, ScreenHeader, Text, theme, useToast } from '@sussurro/ui';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { isApiError, NetworkError } from '../../lib/api/errors';
import { errorMessage, messageForError, OFFLINE_MESSAGE } from '../../lib/error-messages';
import { useAuth, useSignedInUser } from '../auth/AuthProvider';

export const DELETE_CONFIRM_TITLE = 'Excluir conta?';
export const WRONG_PASSWORD_MESSAGE = 'Senha incorreta.';

/**
 * Excluir conta (ux.md §4.7, exigida pela App Store): pede a senha (A-15) e uma confirmação final.
 * A conta some na hora e os dados são apagados em até 30 dias; o @ não volta a ficar livre (A-14).
 */
export function ExcluirContaScreen() {
  const user = useSignedInUser();
  const { deleteAccount } = useAuth();
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);

  const run = async () => {
    setDeleting(true);
    try {
      await deleteAccount(password);
    } catch (caught) {
      setDeleting(false);
      if (caught instanceof NetworkError) {
        toast.show({ message: OFFLINE_MESSAGE, variant: 'error' });
      } else if (isApiError(caught, 'INVALID_CREDENTIALS')) {
        setError(WRONG_PASSWORD_MESSAGE);
      } else if (isApiError(caught, 'RATE_LIMITED')) {
        setError(errorMessage('RATE_LIMITED'));
      } else {
        toast.show({ message: messageForError(caught), variant: 'error' });
      }
    }
  };

  const confirm = () => {
    setError(undefined);
    Alert.alert(DELETE_CONFIRM_TITLE, 'Não dá para desfazer.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Excluir',
        style: 'destructive',
        onPress: () => {
          void run();
        },
      },
    ]);
  };

  const creator = user.accountType === 'creator';

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScreenHeader
        variant="back"
        title="Excluir conta"
        onBack={() => {
          router.back();
        }}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text variant="body">Isso apaga sua conta para sempre:</Text>
          <View style={styles.list}>
            <Text variant="body">• publicações, curtidas e comentários</Text>
            <Text variant="body">{creator ? '• seus seguidores' : '• suas conexões'}</Text>
            <Text variant="body">• sua foto e seus dados</Text>
          </View>
          <Text variant="bodySm" color="grey">
            Some do app na hora; os dados são apagados em até 30 dias. O seu @ (@{user.handle}) não
            poderá ser usado de novo.
          </Text>
          <Input
            label="Senha"
            type="password"
            value={password}
            onChangeText={setPassword}
            testID="excluir-senha"
            {...(error === undefined ? {} : { error })}
          />
          <Button
            variant="destructive"
            label="Excluir minha conta"
            fullWidth
            disabled={password === ''}
            loading={deleting}
            onPress={confirm}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  flex: { flex: 1 },
  content: { padding: theme.layout.screenX, gap: theme.space[12] },
  list: { gap: 2, paddingLeft: theme.space[4] },
});
