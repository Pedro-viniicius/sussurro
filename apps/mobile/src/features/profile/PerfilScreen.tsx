import { Button, ProfileHeader, Text, theme, useToast } from '@sussurro/ui';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ProfilePostsList } from './ProfilePostsList';
import { messageForError } from '../../lib/error-messages';
import { useAuth, useSignedInUser } from '../auth/AuthProvider';
import { PublishingBanners } from '../create/PublishingProvider';
import { profileFor, ROUTES } from '../navigation/routes';

export const SIGN_OUT_TITLE = 'Sair da conta?';

/** Confirmação antes de sair (D-UX16). */
export function confirmSignOut(onConfirm: () => void): void {
  Alert.alert(SIGN_OUT_TITLE, undefined, [
    { text: 'Cancelar', style: 'cancel' },
    { text: 'Sair', style: 'destructive', onPress: onConfirm },
  ]);
}

/** Aviso para confirmar o e-mail (X.3), com reenvio do link. */
function EmailVerificationNotice({ email }: { email: string }) {
  const { resendVerification } = useAuth();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  return (
    <View style={styles.notice} testID="email-verification-notice">
      <Text variant="bodySm">
        Confirme seu e-mail: enviamos um link para <Text variant="bodySmStrong">{email}</Text>.
      </Text>
      <Button
        variant="link"
        size="sm"
        label="Reenviar link"
        loading={sending}
        onPress={() => {
          setSending(true);
          resendVerification()
            .then(() => {
              toast.show({ message: `Enviamos um novo link para ${email}.`, variant: 'success' });
            })
            .catch((error: unknown) => {
              toast.show({ message: messageForError(error), variant: 'error' });
            })
            .finally(() => {
              setSending(false);
            });
        }}
      />
    </View>
  );
}

/**
 * Perfil próprio (p16 pessoal, p19 criador): números reais, abas com as publicações (grade 3:4,
 * textos e Reels na Fase 5) e a faixa "Publicando…" no topo. Na conta pessoal, "conexões" e
 * "criadores" abrem as listas privadas (3.6); seguidores do criador nunca são tocáveis (3.5).
 */
export function PerfilScreen() {
  const user = useSignedInUser();
  const { reloadUser, signOut } = useAuth();

  const openCreate = () => {
    router.push(ROUTES.create);
  };

  const header = (
    <View>
      <ProfileHeader
        handle={user.handle}
        name={user.name}
        bio={user.bio}
        avatarUri={user.avatarUrl}
        avatarSeed={user.id}
        counts={
          user.accountType === 'personal'
            ? { accountType: 'personal', ...user.counts }
            : { accountType: 'creator', ...user.counts }
        }
        onCreate={openCreate}
        onSignOut={() => {
          confirmSignOut(() => {
            void signOut();
          });
        }}
        onEditProfile={() => {
          router.push(ROUTES.editProfile);
        }}
        {...(user.accountType === 'personal'
          ? {
              onOpenConnections: () => {
                router.push(ROUTES.personalConnections);
              },
              onOpenCreators: () => {
                router.push(ROUTES.personalFollowing);
              },
            }
          : {})}
        onPrimaryAction={
          user.accountType === 'personal'
            ? () => {
                router.navigate(ROUTES.personalConnect);
              }
            : openCreate
        }
      />
      {user.emailVerified ? null : <EmailVerificationNotice email={user.email} />}
    </View>
  );

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <PublishingBanners />
      <ProfilePostsList
        handle={user.handle}
        own
        base={profileFor(user.accountType)}
        header={header}
        onRefreshHeader={reloadUser}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  notice: {
    marginTop: theme.space[12],
    marginHorizontal: theme.layout.screenX,
    padding: theme.space[12],
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.blueLight,
    gap: theme.space[4],
    alignItems: 'flex-start',
  },
});
