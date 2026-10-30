import {
  type AccountType,
  EmailSchema,
  HandleSchema,
  isReservedHandle,
  isWeakPassword,
  NameSchema,
  PASSWORD_MAX_LENGTH,
  passwordLength,
} from '@sussurro/shared';
import { Button, Input, RadioOptionList, Text, useToast } from '@sussurro/ui';
import { router } from 'expo-router';
import { useState } from 'react';

import { AuthLayout, FormError } from './AuthLayout';
import { useAuth } from './AuthProvider';
import { isApiError, NetworkError } from '../../lib/api/errors';
import { errorMessage, messageForError, OFFLINE_MESSAGE } from '../../lib/error-messages';
import { LEGAL_OPEN_ERROR, type LegalDocument, openLegal } from '../../lib/legal';
import { ROUTES } from '../navigation/routes';

type Field = 'email' | 'name' | 'handle' | 'password';
type Errors = Partial<Record<Field | 'form', string>>;

export const ACCOUNT_TYPE_OPTIONS = [
  { key: 'personal', title: 'Pessoal', description: 'Conecta-se ao vivo e segue criadores.' },
  { key: 'creator', title: 'Criador', description: 'Só publica. Não segue nem se conecta.' },
] as const;

export const ACCOUNT_TYPE_WARNING = 'Não dá para trocar o tipo de conta depois.';
export const REGISTER_RATE_LIMIT_MESSAGE = 'Muitos cadastros desta rede. Tente mais tarde.';

/** Validação local com as mesmas regras de `packages/shared` que a API aplica. */
export function validateRegistration(values: Record<Field, string>): Errors {
  const errors: Errors = {};
  if (!EmailSchema.safeParse(values.email).success) {
    errors.email = 'Digite um e-mail válido.';
  }
  const name = NameSchema.safeParse(values.name);
  if (!name.success) {
    errors.name = name.error.issues[0]?.message ?? 'Informe o nome.';
  }
  const handle = HandleSchema.safeParse(values.handle);
  if (!handle.success) {
    errors.handle = handle.error.issues[0]?.message ?? errorMessage('VALIDATION_ERROR');
  } else if (isReservedHandle(handle.data)) {
    errors.handle = errorMessage('HANDLE_RESERVED');
  }
  if (passwordLength(values.password) > PASSWORD_MAX_LENGTH) {
    errors.password = `Use no máximo ${String(PASSWORD_MAX_LENGTH)} caracteres.`;
  } else if (isWeakPassword(values.password)) {
    errors.password = errorMessage('WEAK_PASSWORD');
  }
  return errors;
}

/**
 * Cadastro (p05): e-mail, nome, @, senha e tipo de conta como lista com botões de opção, com
 * Pessoal marcado. Ao escolher Criador aparece o aviso de que o tipo é definitivo (D17).
 */
export function CadastroScreen() {
  const { signUp } = useAuth();
  const toast = useToast();
  const [values, setValues] = useState<Record<Field, string>>({
    email: '',
    name: '',
    handle: '',
    password: '',
  });
  const [accountType, setAccountType] = useState<AccountType>('personal');
  const [errors, setErrors] = useState<Errors>({});
  const [loading, setLoading] = useState(false);

  const set = (field: Field) => (value: string) => {
    setValues((current) => ({ ...current, [field]: value }));
  };

  const submit = async () => {
    const local = validateRegistration(values);
    setErrors(local);
    if (Object.keys(local).length > 0) return;

    setLoading(true);
    try {
      await signUp({ ...values, accountType });
    } catch (error) {
      if (error instanceof NetworkError) {
        toast.show({ message: OFFLINE_MESSAGE, variant: 'error' });
      } else if (isApiError(error, 'EMAIL_TAKEN')) {
        setErrors({ email: errorMessage('EMAIL_TAKEN') });
      } else if (isApiError(error, 'HANDLE_TAKEN') || isApiError(error, 'HANDLE_RESERVED')) {
        setErrors({ handle: errorMessage(error.code) });
      } else if (isApiError(error, 'WEAK_PASSWORD')) {
        setErrors({ password: errorMessage('WEAK_PASSWORD') });
      } else if (isApiError(error, 'RATE_LIMITED')) {
        setErrors({ form: REGISTER_RATE_LIMIT_MESSAGE });
      } else if (isApiError(error, 'VALIDATION_ERROR')) {
        const fields = error.fieldPaths().filter((path): path is Field => path in values);
        setErrors(
          fields.length === 0
            ? { form: errorMessage('VALIDATION_ERROR') }
            : Object.fromEntries(fields.map((field) => [field, 'Confira este campo.'])),
        );
      } else {
        setErrors({ form: messageForError(error) });
      }
    } finally {
      setLoading(false);
    }
  };

  // Termos e Política no site público (ux.md §8: rodapé do Cadastro).
  const openDocument = (document: LegalDocument) => {
    void openLegal(document).then((opened) => {
      if (!opened) toast.show({ message: LEGAL_OPEN_ERROR, variant: 'error' });
    });
  };

  const fieldError = (field: Field) =>
    errors[field] === undefined ? {} : { error: errors[field] };

  return (
    <AuthLayout
      intro="Cadastre-se para ver quem você conhece. Só isso."
      footer={{
        question: 'Tem uma conta?',
        linkLabel: 'Entre',
        onPress: () => {
          router.replace(ROUTES.signIn);
        },
      }}
    >
      <Input
        label="E-mail"
        type="email"
        value={values.email}
        onChangeText={set('email')}
        testID="cadastro-email"
        {...fieldError('email')}
      />
      <Input
        label="Nome completo"
        value={values.name}
        onChangeText={set('name')}
        testID="cadastro-nome"
        {...fieldError('name')}
      />
      <Input
        label="Nome de usuário"
        type="username"
        value={values.handle}
        onChangeText={set('handle')}
        testID="cadastro-handle"
        {...fieldError('handle')}
      />
      <Input
        label="Senha"
        type="password"
        passwordPurpose="new"
        value={values.password}
        onChangeText={set('password')}
        testID="cadastro-senha"
        {...fieldError('password')}
      />
      <RadioOptionList
        legend="Tipo de conta"
        options={ACCOUNT_TYPE_OPTIONS}
        value={accountType}
        onChange={setAccountType}
        {...(accountType === 'creator' ? { helper: ACCOUNT_TYPE_WARNING } : {})}
      />
      <Button
        label="Cadastrar-se"
        fullWidth
        loading={loading}
        onPress={() => {
          void submit();
        }}
      />
      <FormError message={errors.form} />
      <Text variant="caption" color="grey" align="center">
        Ao se cadastrar, você concorda com os{' '}
        <Text
          variant="caption"
          color="blue"
          accessibilityRole="link"
          onPress={() => {
            openDocument('terms');
          }}
        >
          Termos de Uso
        </Text>{' '}
        e a{' '}
        <Text
          variant="caption"
          color="blue"
          accessibilityRole="link"
          onPress={() => {
            openDocument('privacy');
          }}
        >
          Política de Privacidade
        </Text>
        .
      </Text>
    </AuthLayout>
  );
}
