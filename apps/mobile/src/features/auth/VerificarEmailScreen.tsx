import { NoContentSchema } from '@sussurro/shared';
import { EmptyState, Text, theme, useToast } from '@sussurro/ui';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from './AuthProvider';
import { isApiError, NetworkError } from '../../lib/api/errors';
import { errorMessage, messageForError } from '../../lib/error-messages';

type Status = 'verifying' | 'verified' | 'invalid' | 'offline';

export const RESEND_SUCCESS_MESSAGE = 'Enviamos um novo link para o seu e-mail.';

/**
 * Sem link, com sessão: a pessoa veio de "Verificar e-mail" (publicar ou comentar com o e-mail não
 * confirmado, X.3). Mostra para onde o link foi e reenvia.
 */
function PendingVerification() {
  const { user, reloadUser, resendVerification } = useAuth();
  const toast = useToast();
  const [sending, setSending] = useState(false);

  // Confirmou em outro lugar (navegador)? Atualiza o estado ao abrir.
  useEffect(() => {
    void reloadUser().catch(() => undefined);
  }, [reloadUser]);

  const back = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  if (user?.emailVerified === true) {
    return (
      <EmptyState
        icon="check"
        title="E-mail confirmado"
        description="Tudo certo. Seu e-mail está confirmado no Sussurro."
        primaryAction={{ label: 'Continuar', onPress: back }}
      />
    );
  }

  return (
    <EmptyState
      icon="lock"
      title="Confirme seu e-mail"
      description={`Enviamos um link para ${user?.email ?? 'o seu e-mail'}. Abra o link neste celular para publicar e comentar.`}
      primaryAction={{
        label: sending ? 'Enviando…' : 'Reenviar link',
        onPress: () => {
          if (sending) return;
          setSending(true);
          resendVerification()
            .then(() => {
              toast.show({ message: RESEND_SUCCESS_MESSAGE, variant: 'success' });
            })
            .catch((error: unknown) => {
              toast.show({ message: messageForError(error), variant: 'error' });
            })
            .finally(() => {
              setSending(false);
            });
        },
      }}
      secondaryAction={{ label: 'Voltar', onPress: back }}
      testID="verificar-email-pendente"
    />
  );
}

/**
 * Confirmação de e-mail (X.3), aberta pelo link do e-mail (`sussurro://verificar-email?token=`).
 * Funciona com ou sem sessão neste aparelho. Sem link e com sessão, mostra o aviso e o reenvio.
 */
export function VerificarEmailScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const { status } = useAuth();
  if ((token === undefined || token === '') && status === 'signedIn') {
    return (
      <SafeAreaView style={styles.screen}>
        <PendingVerification />
      </SafeAreaView>
    );
  }
  return <VerifyToken token={token} />;
}

function VerifyToken({ token }: { token: string | undefined }) {
  const { api, status: session, reloadUser, resendVerification } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<Status>(
    token === undefined || token === '' ? 'invalid' : 'verifying',
  );
  const [attempt, setAttempt] = useState(0);
  // Uma requisição por tentativa: o token é de uso único, e o efeito pode rodar duas vezes em dev.
  const requests = useRef(new Map<string, Promise<Status>>());

  useEffect(() => {
    if (token === undefined || token === '') return undefined;
    const key = `${token}#${String(attempt)}`;
    let request = requests.current.get(key);
    if (request === undefined) {
      request = api
        .request('/v1/auth/email/verify', {
          method: 'POST',
          body: { token },
          schema: NoContentSchema,
          auth: false,
        })
        .then(
          (): Status => 'verified',
          (error: unknown): Status => (error instanceof NetworkError ? 'offline' : 'invalid'),
        );
      requests.current.set(key, request);
    }
    let active = true;
    void request.then((result) => {
      if (active) setStatus(result);
    });
    return () => {
      active = false;
    };
  }, [api, token, attempt]);

  const continueToApp = async () => {
    if (session === 'signedIn') {
      await reloadUser().catch(() => undefined);
    }
    router.replace('/');
  };

  const resend = async () => {
    try {
      await resendVerification();
      toast.show({ message: RESEND_SUCCESS_MESSAGE, variant: 'success' });
    } catch (error) {
      toast.show({
        message: isApiError(error, 'RATE_LIMITED')
          ? errorMessage('RATE_LIMITED')
          : messageForError(error),
        variant: 'error',
      });
    }
  };

  return (
    <SafeAreaView style={styles.screen}>
      {status === 'verifying' ? (
        <View style={styles.center}>
          <ActivityIndicator color={theme.colors.blue} />
          <Text variant="body" color="grey">
            Confirmando seu e-mail…
          </Text>
        </View>
      ) : null}
      {status === 'verified' ? (
        <EmptyState
          icon="check"
          title="E-mail confirmado"
          description="Tudo certo. Seu e-mail está confirmado no Sussurro."
          primaryAction={{
            label: 'Continuar',
            onPress: () => {
              void continueToApp();
            },
          }}
        />
      ) : null}
      {status === 'invalid' ? (
        <EmptyState
          icon="circle-alert"
          title="Link inválido"
          description={errorMessage('INVALID_TOKEN')}
          {...(session === 'signedIn'
            ? {
                primaryAction: {
                  label: 'Enviar outro link',
                  onPress: () => {
                    void resend();
                  },
                },
              }
            : {})}
          secondaryAction={{
            label: 'Voltar ao início',
            onPress: () => {
              router.replace('/');
            },
          }}
        />
      ) : null}
      {status === 'offline' ? (
        <EmptyState
          icon="wifi-off"
          title="Sem internet"
          description="Não foi possível confirmar agora. Confira a conexão e tente de novo."
          primaryAction={{
            label: 'Tentar de novo',
            onPress: () => {
              setStatus('verifying');
              setAttempt((value) => value + 1);
            },
          }}
        />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.space[12] },
});
