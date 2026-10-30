import type { AccountType } from '@sussurro/shared';
import { ScreenHeader, Text, theme, useToast } from '@sussurro/ui';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { messageForError } from '../../lib/error-messages';
import { LEGAL_OPEN_ERROR, type LegalDocument, openLegal } from '../../lib/legal';
import { useAuth, useSignedInUser } from '../auth/AuthProvider';
import { ROUTES } from '../navigation/routes';
import { useNotifications } from '../notifications/NotificationsProvider';
import { confirmSignOut } from '../profile/PerfilScreen';

function Row({
  label,
  onPress,
  danger = false,
  chevron = false,
}: {
  label: string;
  onPress: () => void;
  danger?: boolean;
  chevron?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Text variant="body" color={danger ? 'danger' : 'black'}>
        {label}
      </Text>
      {chevron ? (
        <Text variant="body" color="grey">
          ›
        </Text>
      ) : null}
    </Pressable>
  );
}

export const PUSH_SETTING_LABEL = 'Notificações neste celular';
export const PUSH_SETTING_FAILED = 'Não foi possível ativar as notificações. Tente de novo.';
export const PUSH_BLOCKED_TITLE = 'Notificações bloqueadas';
export const PUSH_BLOCKED_TEXT = 'Permita as notificações do Sussurro nos Ajustes do celular.';

export function pushSettingHelp(accountType: AccountType): string {
  return accountType === 'creator'
    ? 'Curtidas, comentários, respostas e novos seguidores. O texto dos comentários não aparece no aviso.'
    : 'Curtidas, comentários, respostas e conexões. O texto dos comentários não aparece no aviso.';
}

/**
 * Notificações no celular (6.4): ativar pede a permissão do sistema (ou leva aos Ajustes, se ela
 * foi negada de vez) e registra o token; desligar chama o `DELETE /me/push-tokens`. Sem rede, nada
 * muda e aparece o erro.
 */
function PushSettingRow({ accountType }: { accountType: AccountType }) {
  const { pushSetting, enablePush, disablePush, openPushSettings } = useNotifications();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (pushSetting === 'unsupported') return null;

  const change = (next: boolean) => {
    setBusy(true);
    const action = next
      ? enablePush().then((result) => {
          if (result === 'failed') toast.show({ message: PUSH_SETTING_FAILED, variant: 'error' });
          if (result === 'blocked') {
            Alert.alert(PUSH_BLOCKED_TITLE, PUSH_BLOCKED_TEXT, [
              { text: 'Agora não', style: 'cancel' },
              { text: 'Abrir Ajustes', onPress: openPushSettings },
            ]);
          }
        })
      : disablePush().catch((error: unknown) => {
          toast.show({ message: messageForError(error), variant: 'error' });
        });
    void action.finally(() => {
      setBusy(false);
    });
  };

  return (
    <View style={styles.group}>
      <View style={styles.row}>
        <Text variant="body" style={styles.flex}>
          {PUSH_SETTING_LABEL}
        </Text>
        <Switch
          accessibilityLabel={PUSH_SETTING_LABEL}
          value={pushSetting === 'on'}
          disabled={busy || pushSetting === 'loading'}
          onValueChange={change}
          trackColor={{ false: theme.colors.border, true: theme.colors.blue }}
          thumbColor={theme.colors.white}
          ios_backgroundColor={theme.colors.border}
          testID="conta-notificacoes"
        />
      </View>
      <Text variant="bodySm" color="grey">
        {pushSettingHelp(accountType)}
      </Text>
    </View>
  );
}

/**
 * Conta (ux.md §4.7): e-mail, sair deste aparelho ou de todos, contas bloqueadas (X.2), Termos de
 * uso e Política de privacidade (site público), notificações no celular (Fase 6) e excluir conta.
 */
export function ContaScreen() {
  const user = useSignedInUser();
  const { signOut, resendVerification } = useAuth();
  const toast = useToast();

  const openDocument = (document: LegalDocument) => {
    void openLegal(document).then((opened) => {
      if (!opened) toast.show({ message: LEGAL_OPEN_ERROR, variant: 'error' });
    });
  };

  const signOutEverywhere = () => {
    Alert.alert(
      'Sair de todos os dispositivos?',
      'Você vai precisar entrar de novo em todos os aparelhos.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Sair de todos',
          style: 'destructive',
          onPress: () => {
            signOut({ everywhere: true }).catch((error: unknown) => {
              toast.show({ message: messageForError(error), variant: 'error' });
            });
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
      <ScreenHeader
        variant="back"
        title="Conta"
        onBack={() => {
          router.back();
        }}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.section}>
          <Text variant="caption" color="grey">
            E-mail
          </Text>
          <Text variant="body">{user.email}</Text>
          {user.emailVerified ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Reenviar link de confirmação"
              onPress={() => {
                resendVerification()
                  .then(() => {
                    toast.show({ message: 'Enviamos um novo link.', variant: 'success' });
                  })
                  .catch((error: unknown) => {
                    toast.show({ message: messageForError(error), variant: 'error' });
                  });
              }}
            >
              <Text variant="bodySm" color="blue">
                Não confirmado · Reenviar link
              </Text>
            </Pressable>
          )}
        </View>
        <View style={styles.group}>
          <Row
            label="Sair deste dispositivo"
            onPress={() => {
              confirmSignOut(() => {
                void signOut();
              });
            }}
          />
          <Row label="Sair de todos os dispositivos" onPress={signOutEverywhere} />
        </View>
        <PushSettingRow accountType={user.accountType} />
        <View style={styles.group}>
          <Row
            label="Contas bloqueadas"
            chevron
            onPress={() => {
              router.push(ROUTES.blockedAccounts);
            }}
          />
        </View>
        <View style={styles.group}>
          <Row
            label="Termos de uso"
            chevron
            onPress={() => {
              openDocument('terms');
            }}
          />
          <Row
            label="Política de privacidade"
            chevron
            onPress={() => {
              openDocument('privacy');
            }}
          />
        </View>
        <View style={styles.group}>
          <Row
            label="Excluir conta"
            danger
            onPress={() => {
              router.push(ROUTES.deleteAccount);
            }}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  content: { padding: theme.layout.screenX, gap: theme.space[16] },
  section: { gap: 2 },
  group: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border,
  },
  row: {
    minHeight: theme.layout.hitMin,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  pressed: { opacity: theme.opacity.pressed },
  flex: { flex: 1 },
});
