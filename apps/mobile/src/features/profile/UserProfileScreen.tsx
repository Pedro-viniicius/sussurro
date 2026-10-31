import type { PublicProfile } from '@sussurro/shared';
import {
  EmptyState,
  ProfileHeader,
  ScreenHeader,
  Skeleton,
  theme,
  useActionSheet,
} from '@sussurro/ui';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ProfilePostsList } from './ProfilePostsList';
import { isApiError } from '../../lib/api/errors';
import { messageForError } from '../../lib/error-messages';
import { useAuth, useSignedInUser } from '../auth/AuthProvider';
import { DISCONNECT_ACTION, useRemoveConnection } from '../connect/useRemoveConnection';
import { useModerationMenu } from '../moderation/useModerationMenu';
import { profileFor, type TabBase } from '../navigation/routes';
import { fetchProfile } from '../posts/api';
import { useTabBase } from '../posts/navigation';
import { useFollowing, useFollowStore } from '../relations/follow-store';
import { useFollowToggle } from '../relations/useFollowToggle';

export const PROFILE_UNAVAILABLE_TITLE = 'Perfil indisponível';

function back() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; profile: PublicProfile }
  | { status: 'notFound' }
  | { status: 'error'; error: unknown };

/** O perfil carregado: Seguir/Seguindo (criador visto por pessoa), Conectados e o menu ⋯. */
function LoadedProfile({
  profile,
  base,
  onRefresh,
}: {
  profile: PublicProfile;
  base: TabBase;
  onRefresh: () => Promise<unknown>;
}) {
  const user = useSignedInUser();
  const toggle = useFollowToggle();
  const menu = useModerationMenu();
  const connectionMenu = useActionSheet('connection-menu');
  const removeConnection = useRemoveConnection();
  const followedByMe = profile.accountType === 'creator' ? profile.followedByMe : false;
  const following = useFollowing(profile.handle, followedByMe);
  // Só pessoa segue, e só criador é seguido (o servidor recusa o resto, PERM-01 e PERM-03).
  const canFollow = profile.accountType === 'creator' && user.accountType === 'personal';
  // Perfil pessoal de outra pessoa só abre para conexões (o servidor responde 404 ao resto).
  const isConnection = profile.accountType === 'personal' && user.accountType === 'personal';

  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID="tela-perfil-outro">
      <ProfilePostsList
        handle={profile.handle}
        own={false}
        base={base}
        onRefreshHeader={onRefresh}
        header={
          <ProfileHeader
            mode="other"
            handle={profile.handle}
            name={profile.name}
            bio={profile.bio}
            avatarUri={profile.avatarUrl}
            counts={
              profile.accountType === 'personal'
                ? { accountType: 'personal', ...profile.counts }
                : { accountType: 'creator', ...profile.counts }
            }
            onBack={back}
            onMore={() => {
              // Depois de bloquear, os dois perfis viram 404: sai do perfil (X.2).
              menu.open({ type: 'account', handle: profile.handle }, back);
            }}
            {...(canFollow
              ? {
                  follow: {
                    following,
                    onPress: () => {
                      void toggle(profile.handle, following);
                    },
                  },
                }
              : {})}
            {...(isConnection
              ? {
                  connection: {
                    onPress: () => {
                      connectionMenu.show({
                        actions: [
                          {
                            label: DISCONNECT_ACTION,
                            destructive: true,
                            onPress: () => {
                              // Desfeita, o perfil vira 404: sai dele (como no bloqueio).
                              removeConnection(profile.handle, { onRemoved: back });
                            },
                          },
                        ],
                      });
                    },
                  },
                }
              : {})}
          />
        }
      />
      {menu.element}
      {connectionMenu.element}
    </SafeAreaView>
  );
}

/**
 * Perfil de outra conta (`u/[handle]`): criador visto por qualquer conta (p17) ou conexão
 * (ux.md §4.9), pelo `GET /users/:handle` e as abas de publicações. Conta pessoal sem conexão
 * recebe o mesmo 404 de inexistente: "Perfil indisponível". O criador visto por pessoa tem
 * Seguir/Seguindo (3.3, otimista); todo perfil de outra conta tem o menu ⋯ com "Denunciar" e
 * "Bloquear" (D-UX14). Na conexão, (Conectados ✓) abre "Desfazer conexão" (4.9, D8).
 */
export function UserProfileScreen() {
  const { handle } = useLocalSearchParams<{ handle: string }>();
  const user = useSignedInUser();
  const { api } = useAuth();
  const follows = useFollowStore();
  const base = useTabBase(user.accountType);
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const load = useCallback(async () => {
    const profile = await fetchProfile(api, handle);
    if (profile.accountType === 'creator') follows.set(profile.handle, profile.followedByMe);
    setState({ status: 'ready', profile });
    return profile;
  }, [api, follows, handle]);

  useEffect(() => {
    let active = true;
    fetchProfile(api, handle)
      .then((profile) => {
        if (!active) return;
        if (profile.accountType === 'creator') follows.set(profile.handle, profile.followedByMe);
        setState({ status: 'ready', profile });
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState(
          isApiError(error, 'NOT_FOUND') ? { status: 'notFound' } : { status: 'error', error },
        );
      });
    return () => {
      active = false;
    };
  }, [api, follows, handle, attempt]);

  if (handle === user.handle) {
    return <Redirect href={profileFor(user.accountType)} />;
  }

  if (state.status !== 'ready') {
    return (
      <SafeAreaView style={styles.screen} edges={['top']} testID="tela-perfil-outro">
        <ScreenHeader variant="back" title={handle} onBack={back} />
        {state.status === 'loading' ? (
          <View style={styles.loading} testID="perfil-outro-carregando">
            <Skeleton width={86} height={86} radius={43} />
            <Skeleton width="60%" height={16} />
          </View>
        ) : state.status === 'notFound' ? (
          <EmptyState
            icon="lock"
            title={PROFILE_UNAVAILABLE_TITLE}
            description="Contas pessoais só aparecem para as conexões delas."
            primaryAction={{ label: 'Voltar', onPress: back }}
            testID="perfil-indisponivel"
          />
        ) : (
          <EmptyState
            icon="circle-alert"
            title="Não foi possível carregar"
            description={messageForError(state.error)}
            primaryAction={{
              label: 'Tentar de novo',
              onPress: () => {
                setState({ status: 'loading' });
                setAttempt((value) => value + 1);
              },
            }}
          />
        )}
      </SafeAreaView>
    );
  }

  return <LoadedProfile profile={state.profile} base={base} onRefresh={load} />;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  loading: { padding: theme.layout.screenX, gap: theme.space[12] },
});
