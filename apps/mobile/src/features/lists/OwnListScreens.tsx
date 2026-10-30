import type { BlockedAccount, OwnListItem } from '@sussurro/shared';
import {
  Button,
  followButtonLabel,
  formatShortDate,
  IconButton,
  useActionSheet,
  UserRow,
} from '@sussurro/ui';
import { router } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { Alert } from 'react-native';

import { OwnListScreen } from './OwnListScreen';
import { useCursorList } from './useCursorList';
import { useAuth, useSignedInUser } from '../auth/AuthProvider';
import { DISCONNECT_ACTION, useRemoveConnection } from '../connect/useRemoveConnection';
import { useUnblockAccount } from '../moderation/useBlockAccount';
import { ROUTES } from '../navigation/routes';
import { profileHref } from '../posts/navigation';
import { useDisconnectedAuthors, useHiddenAuthors } from '../posts/post-store';
import { fetchBlocks, fetchConnections, fetchFollowing } from '../relations/api';
import { useFollowStore, useUnfollowed } from '../relations/follow-store';
import { useFollowToggle } from '../relations/useFollowToggle';

const byHandle = (item: { handle: string }) => item.handle;

/** "Caio Ribeiro · desde 27 out" (ux.md §4.8). */
function sinceLabel(item: OwnListItem): string {
  return `${item.name} · desde ${formatShortDate(item.since)}`;
}

export function unfollowTitle(handle: string): string {
  return `Deixar de seguir @${handle}?`;
}

/** Abre o perfil dentro da aba Perfil (a aba de origem continua ativa). */
function useOpenProfile() {
  const user = useSignedInUser();
  return useCallback(
    (handle: string) => {
      router.push(profileHref(ROUTES.personalProfile, handle, user));
    },
    [user],
  );
}

/**
 * Minhas conexões (`GET /me/connections`, 3.6). O "···" de cada linha abre "Desfazer conexão"
 * (4.9, D8): a linha some na hora (também quando desfeita pelo perfil), e volta se a API falhar.
 */
export function ConnectionsScreen() {
  const { api } = useAuth();
  const hidden = useHiddenAuthors();
  const openProfile = useOpenProfile();
  const menu = useActionSheet('connection-menu');
  const removeConnection = useRemoveConnection();
  const removed = useDisconnectedAuthors();
  const fetchPage = useCallback((cursor?: string) => fetchConnections(api, cursor), [api]);
  const list = useCursorList(fetchPage, byHandle);
  const visible = useMemo(
    () => list.items.filter((item) => !hidden.has(item.handle) && !removed.has(item.handle)),
    [hidden, list.items, removed],
  );

  const openMenu = (handle: string) => {
    menu.show({
      title: `Conexão com @${handle}`,
      actions: [
        {
          label: DISCONNECT_ACTION,
          destructive: true,
          onPress: () => {
            // A linha some (e volta, se falhar) pelo conjunto de conexões desfeitas.
            removeConnection(handle, { onRemoved: () => undefined });
          },
        },
      ],
    });
  };

  return (
    <>
      <OwnListScreen
        title="Conexões"
        testID="tela-conexoes"
        list={list}
        visibleItems={visible}
        keyOf={byHandle}
        renderRow={(item) => (
          <UserRow
            handle={item.handle}
            name={item.name}
            avatarUri={item.avatarUrl}
            subtitle={sinceLabel(item)}
            onPress={() => {
              openProfile(item.handle);
            }}
            action={
              <IconButton
                icon="ellipsis"
                accessibilityLabel={`Mais opções para @${item.handle}`}
                onPress={() => {
                  openMenu(item.handle);
                }}
              />
            }
          />
        )}
        empty={{
          icon: 'radio',
          title: 'Nenhuma conexão ainda',
          description: 'Conexões acontecem ao vivo: as duas pessoas confirmam, uma perto da outra.',
          primaryAction: {
            label: 'Conectar ao vivo',
            onPress: () => {
              router.navigate(ROUTES.personalConnect);
            },
          },
        }}
      />
      {menu.element}
    </>
  );
}

/**
 * Criadores que sigo (`GET /me/following`, 3.6): (Seguindo) à direita; o toque pede confirmação e
 * deixa de seguir na hora (a linha some; volta com Toast se falhar).
 */
export function FollowingScreen() {
  const { api } = useAuth();
  const hidden = useHiddenAuthors();
  const follows = useFollowStore();
  const toggle = useFollowToggle();
  const openProfile = useOpenProfile();
  // Cada página que chega diz que a pessoa segue esses criadores (a resposta mais nova vence).
  const fetchPage = useCallback(
    async (cursor?: string) => {
      const page = await fetchFollowing(api, cursor);
      follows.merge(page.items.map((item) => [item.handle, true] as const));
      return page;
    },
    [api, follows],
  );
  const list = useCursorList(fetchPage, byHandle);
  const handles = useMemo(() => list.items.map(byHandle), [list.items]);
  const unfollowed = useUnfollowed(handles);
  const visible = useMemo(
    () => list.items.filter((item) => !hidden.has(item.handle) && !unfollowed.has(item.handle)),
    [hidden, list.items, unfollowed],
  );

  const confirmUnfollow = (handle: string) => {
    Alert.alert(unfollowTitle(handle), `As publicações de @${handle} saem do seu início.`, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Deixar de seguir',
        style: 'destructive',
        onPress: () => {
          void toggle(handle, true);
        },
      },
    ]);
  };

  return (
    <OwnListScreen
      title="Criadores que sigo"
      testID="tela-seguindo"
      list={list}
      visibleItems={visible}
      keyOf={byHandle}
      renderRow={(item) => (
        <UserRow
          handle={item.handle}
          name={item.name}
          avatarUri={item.avatarUrl}
          subtitle={sinceLabel(item)}
          onPress={() => {
            openProfile(item.handle);
          }}
          action={
            <Button
              variant="secondary"
              size="sm"
              label="Seguindo"
              accessibilityLabel={followButtonLabel(item.handle, true)}
              onPress={() => {
                confirmUnfollow(item.handle);
              }}
            />
          }
        />
      )}
      empty={{
        icon: 'search',
        title: 'Você ainda não segue criadores',
        description: 'Procure criadores pelo @ e siga quem você quer acompanhar.',
        primaryAction: {
          label: 'Pesquisar criadores',
          onPress: () => {
            router.navigate(ROUTES.personalSearch);
          },
        },
      }}
    />
  );
}

/** "Bloqueio em 27 out": só o @ e a data (a lista não traz nome nem foto, X.2). */
function blockedLabel(item: BlockedAccount): string {
  return `Bloqueio em ${formatShortDate(item.blockedAt)}`;
}

/** Contas bloqueadas (`GET /me/blocks`, X.2), na tela Conta, para os dois tipos de conta. */
export function BlockedAccountsScreen() {
  const { api } = useAuth();
  const unblock = useUnblockAccount();
  const fetchPage = useCallback((cursor?: string) => fetchBlocks(api, cursor), [api]);
  const list = useCursorList(fetchPage, byHandle);
  const { remove } = list;

  return (
    <OwnListScreen
      title="Contas bloqueadas"
      testID="tela-bloqueados"
      list={list}
      visibleItems={list.items}
      keyOf={byHandle}
      renderRow={(item) => (
        <UserRow
          handle={item.handle}
          subtitle={blockedLabel(item)}
          action={
            <Button
              variant="secondary"
              size="sm"
              label="Desbloquear"
              accessibilityLabel={`Desbloquear @${item.handle}`}
              onPress={() => {
                unblock(item.handle, () => {
                  remove(item.handle);
                });
              }}
            />
          }
        />
      )}
      empty={{
        icon: 'lock',
        title: 'Nenhuma conta bloqueada',
        description: 'Quando você bloqueia alguém, a conta aparece aqui.',
      }}
    />
  );
}
