import { Button, Input, useToast } from '@sussurro/ui';
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { AuthLayout, FormError } from './AuthLayout';
import { useAuth } from './AuthProvider';
import { isApiError, NetworkError } from '../../lib/api/errors';
import { isDevRoutesEnabled } from '../../lib/dev-routes';
import { messageForError, OFFLINE_MESSAGE } from '../../lib/error-messages';
import { ROUTES } from '../navigation/routes';

interface Errors {
  email?: string;
  password?: string;
  form?: string;
}

export const INVALID_LOGIN_MESSAGE = 'E-mail ou senha incorretos.';
export const LOGIN_RATE_LIMIT_MESSAGE = 'Muitas tentativas. Tente de novo em 1 minuto.';

/**
 * Entrar (p01). Só e-mail (D14) e sem "Entrar na conta de criador (demo)" (D15): o separador "OU"
 * sai junto. "Esqueceu a senha?" fica sob o campo de senha (D-UX15).
 */
export function EntrarScreen() {
  const { signIn, lastEmail } = useAuth();
  const toast = useToast();
  // null = ainda não editado: mostra o último e-mail usado, que chega assíncrono do secure-store.
  const [typedEmail, setEmail] = useState<string | null>(null);
  const email = typedEmail ?? lastEmail ?? '';
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const next: Errors = {};
    if (email.trim() === '') next.email = 'Digite seu e-mail.';
    if (password === '') next.password = 'Digite sua senha.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setLoading(true);
    try {
      await signIn({ email, password });
    } catch (error) {
      if (error instanceof NetworkError) {
        toast.show({ message: OFFLINE_MESSAGE, variant: 'error' });
      } else if (isApiError(error, 'INVALID_CREDENTIALS')) {
        setErrors({ form: INVALID_LOGIN_MESSAGE });
      } else if (isApiError(error, 'RATE_LIMITED')) {
        setErrors({ form: LOGIN_RATE_LIMIT_MESSAGE });
      } else if (isApiError(error, 'VALIDATION_ERROR')) {
        setErrors(
          error.fieldPaths().includes('email')
            ? { email: 'Digite um e-mail válido.' }
            : { form: INVALID_LOGIN_MESSAGE },
        );
      } else {
        setErrors({ form: messageForError(error) });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout
      footer={{
        question: 'Não tem uma conta?',
        linkLabel: 'Cadastre-se',
        onPress: () => {
          router.push(ROUTES.signUp);
        },
      }}
    >
      <Input
        label="E-mail"
        type="email"
        value={email}
        onChangeText={setEmail}
        testID="entrar-email"
        {...(errors.email === undefined ? {} : { error: errors.email })}
      />
      <Input
        label="Senha"
        type="password"
        value={password}
        onChangeText={setPassword}
        onSubmitEditing={() => {
          void submit();
        }}
        testID="entrar-senha"
        {...(errors.password === undefined ? {} : { error: errors.password })}
      />
      <View style={{ alignItems: 'flex-end' }}>
        <Button
          variant="link"
          size="sm"
          label="Esqueceu a senha?"
          onPress={() => {
            router.push(ROUTES.forgotPassword);
          }}
        />
      </View>
      <Button
        label="Entrar"
        fullWidth
        loading={loading}
        onPress={() => {
          void submit();
        }}
      />
      <FormError message={errors.form} />
      {/* D15: ferramentas de desenvolvimento só nas rotas /dev, e só em dev. */}
      {isDevRoutesEnabled() ? (
        <View style={{ alignItems: 'center' }}>
          <Button
            variant="link"
            size="sm"
            label="Catálogo de componentes (dev)"
            onPress={() => {
              router.push('/dev/catalog');
            }}
          />
        </View>
      ) : null}
    </AuthLayout>
  );
}
