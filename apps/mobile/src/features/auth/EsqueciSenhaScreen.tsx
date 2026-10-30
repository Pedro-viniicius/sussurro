import { EmailSchema, NoContentSchema } from '@sussurro/shared';
import { Button, Input, Text, useToast } from '@sussurro/ui';
import { router } from 'expo-router';
import { useState } from 'react';

import { AuthLayout, FormError } from './AuthLayout';
import { useAuth } from './AuthProvider';
import { NetworkError } from '../../lib/api/errors';
import { messageForError, OFFLINE_MESSAGE } from '../../lib/error-messages';
import { ROUTES } from '../navigation/routes';

export const FORGOT_PASSWORD_SENT =
  'Se houver uma conta com esse e-mail, enviamos um link para redefinir a senha. Ele vale por 1 hora.';

/** "Esqueci a senha" (história 1.10): a resposta é a mesma exista o e-mail ou não. */
export function EsqueciSenhaScreen() {
  const { api, lastEmail } = useAuth();
  const toast = useToast();
  const [email, setEmail] = useState(lastEmail ?? '');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async () => {
    setFormError(undefined);
    if (!EmailSchema.safeParse(email).success) {
      setError('Digite um e-mail válido.');
      return;
    }
    setError(undefined);
    setLoading(true);
    try {
      await api.request('/v1/auth/password/forgot', {
        method: 'POST',
        body: { email },
        schema: NoContentSchema,
        auth: false,
      });
      setSent(true);
    } catch (caught) {
      if (caught instanceof NetworkError) {
        toast.show({ message: OFFLINE_MESSAGE, variant: 'error' });
      } else {
        setFormError(messageForError(caught));
      }
    } finally {
      setLoading(false);
    }
  };

  const backToSignIn = () => {
    router.replace(ROUTES.signIn);
  };

  if (sent) {
    return (
      <AuthLayout intro="Confira seu e-mail">
        <Text variant="body" align="center" accessibilityRole="alert">
          {FORGOT_PASSWORD_SENT}
        </Text>
        <Button label="Voltar para Entrar" fullWidth onPress={backToSignIn} />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout
      intro="Digite o e-mail da sua conta para receber o link de redefinição."
      footer={{ question: 'Lembrou a senha?', linkLabel: 'Entre', onPress: backToSignIn }}
    >
      <Input
        label="E-mail"
        type="email"
        value={email}
        onChangeText={setEmail}
        testID="esqueci-email"
        {...(error === undefined ? {} : { error })}
      />
      <Button
        label="Enviar link"
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
