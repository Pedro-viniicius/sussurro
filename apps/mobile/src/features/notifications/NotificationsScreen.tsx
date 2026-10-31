import {
  followersBadge,
  groupNotifications,
  type Notification,
  type NotificationPost,
  notificationPlainText,
  notificationTextParts,
} from '@sussurro/shared';
import {
  Button,
  EmptyState,
  formatShortTime,
  NotificationRow,
  type NotificationRowAvatar,
  ScreenHeader,
  Skeleton,
  spokenShortTime,
  Text,
  theme,
} from '@sussurro/ui';
import { router, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { ActivityIndicator, RefreshControl, SectionList, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { fetchNotifications, markNotificationsRead } from './api';
import { useNotifications } from './NotificationsProvider';
import { messageForError } from '../../lib/error-messages';
import { useAuth, useSignedInUser } from '../auth/AuthProvider';
import { useCursorList } from '../lists/useCursorList';
import type { TabBase } from '../navigation/routes';
import { postHref, profileHref, reelHref, useTabBase } from '../posts/navigation';

export const NOTIFICATIONS_TITLE = 'Notificações';
/** ux.md §5.1 (Notificações). */
export const NOTIFICATIONS_EMPTY_TITLE = 'Nada por aqui ainda.';
export const NOTIFICATIONS_EMPTY_TEXT = 'Quando alguém curtir ou comentar, aparece aqui.';
export const NOTIFICATIONS_ERROR_TITLE = 'Não foi possível carregar';
export const NOTIFICATIONS_END = 'Isso é tudo por enquanto.';
export const LOAD_MORE_FAILED = 'Não carregou.';

function keyOf(notification: Notification): string {
  return notification.id;
}

function back() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function RowSkeleton() {
  return (
    <View style={styles.skeletonRow}>
      <Skeleton width={44} height={44} radius={22} />
      <View style={styles.skeletonTexts}>
        <Skeleton width="70%" height={14} />
        <Skeleton width="40%" height={12} />
      </View>
      <Skeleton width={44} height={44} radius={theme.radius.sm} />
    </View>
  );
}

/** Abre o post da notificação: reel no visualizador (5.5), foto e texto no detalhe `p/[id]`. */
function openPost(post: NotificationPost, base: TabBase) {
  router.push(post.type === 'reel' ? reelHref(post.id, base) : postHref(base, post.id));
}

/**
 * Notificações (p09 da pessoa, empilhada no Início com a tab bar; p21 do criador, na aba): "Hoje",
 * "Esta semana" e "Anteriores" pelo fuso do aparelho (A-35), paginação por cursor, puxar para
 * atualizar e os estados do ux.md §5.1. Ao abrir, marca como lidas até a primeira mostrada
 * (`POST /notifications/read {upTo}`), e o ponto azul some (6.2).
 */
export function NotificationsScreen({ variant }: { variant: 'personal' | 'creator' }) {
  const user = useSignedInUser();
  const { api } = useAuth();
  const { unreadCount, setUnreadCount, refreshUnread, pushTick } = useNotifications();
  const base = useTabBase(user.accountType);
  const focused = useIsFocused();
  const fetchPage = useCallback((cursor?: string) => fetchNotifications(api, cursor), [api]);
  const list = useCursorList(fetchPage, keyOf);
  const { refresh } = list;

  // Marca como lidas até a primeira mostrada: ao abrir, ao puxar e quando chega uma nova.
  const first = list.status === 'ready' ? list.items[0] : undefined;
  const hasUnreadItem = list.items.some((item) => !item.read);
  const marked = useRef<string | null>(null);
  useEffect(() => {
    if (first === undefined || !focused || marked.current === first.updatedAt) return;
    if (!hasUnreadItem && unreadCount === 0) return;
    marked.current = first.updatedAt;
    setUnreadCount(0);
    markNotificationsRead(api, first.updatedAt)
      .then(({ count }) => {
        setUnreadCount(count);
      })
      .catch(() => {
        // Não marcou: o ponto volta a refletir o servidor; puxar para atualizar tenta de novo.
        refreshUnread();
      });
  }, [api, first, focused, hasUnreadItem, refreshUnread, setUnreadCount, unreadCount]);

  // Push recebido com a tela aberta: a lista atualiza (e a nova é marcada como lida).
  const lastTick = useRef(pushTick);
  useEffect(() => {
    if (pushTick === lastTick.current) return;
    lastTick.current = pushTick;
    if (focused) void refresh();
  }, [focused, pushTick, refresh]);

  const sections = groupNotifications(list.items, new Date()).map((section) => ({
    key: section.key,
    title: section.title,
    data: section.items,
  }));

  const renderRow = (notification: Notification) => {
    const parts = notificationTextParts(notification);
    const read = notification.read ? '' : ', nova';
    const label = `${notificationPlainText(notification)} ${spokenShortTime(notification.updatedAt)}${read}`;
    const testID = `notificacao-${notification.id}`;
    const common = {
      parts,
      time: formatShortTime(notification.updatedAt),
      unread: !notification.read,
      accessibilityLabel: label,
      testID,
    };
    if (notification.type === 'new_followers') {
      const avatar: NotificationRowAvatar = {
        kind: 'aggregate',
        count: notification.count,
        label: followersBadge(notification.count),
      };
      return <NotificationRow {...common} avatar={avatar} />;
    }
    const { actor } = notification;
    const avatar: NotificationRowAvatar = {
      kind: 'account',
      handle: actor.handle,
      name: actor.name,
      uri: actor.avatarUrl,
    };
    // D11/A-07: o @ só é tocável quando quem lê pode ver o perfil.
    const openProfile = actor.profileVisible
      ? () => {
          router.push(profileHref(base, actor.handle, user));
        }
      : undefined;
    const profileProps =
      openProfile === undefined
        ? {}
        : { onPressHandle: openProfile, handleActionLabel: `Abrir o perfil de @${actor.handle}` };
    if (notification.type === 'connection_created') {
      return (
        <NotificationRow
          {...common}
          avatar={avatar}
          {...profileProps}
          {...(openProfile === undefined
            ? {}
            : { onPress: openProfile, accessibilityHint: 'Abre o perfil' })}
        />
      );
    }
    const { post } = notification;
    return (
      <NotificationRow
        {...common}
        avatar={avatar}
        thumbnail={post.thumbUrl === null ? null : { key: post.id, uri: post.thumbUrl }}
        onPress={() => {
          openPost(post, base);
        }}
        accessibilityHint={post.type === 'reel' ? 'Abre o reel' : 'Abre a publicação'}
        {...profileProps}
      />
    );
  };

  const emptyComponent =
    list.status === 'loading' ? (
      <View testID="notificacoes-carregando">
        <RowSkeleton />
        <RowSkeleton />
        <RowSkeleton />
      </View>
    ) : list.status === 'error' ? (
      <EmptyState
        icon="circle-alert"
        title={NOTIFICATIONS_ERROR_TITLE}
        description={messageForError(list.error)}
        primaryAction={{
          label: 'Tentar de novo',
          onPress: () => {
            void list.reload();
          },
        }}
        testID="notificacoes-erro"
      />
    ) : (
      <EmptyState
        icon="heart"
        title={NOTIFICATIONS_EMPTY_TITLE}
        description={NOTIFICATIONS_EMPTY_TEXT}
        testID="notificacoes-vazia"
      />
    );

  const footer =
    list.items.length === 0 ? null : list.loadingMore ? (
      <ActivityIndicator style={styles.footer} color={theme.colors.grey} />
    ) : list.loadMoreFailed ? (
      <View style={[styles.footer, styles.footerRow]} testID="notificacoes-mais-falhou">
        <Text variant="bodySm" color="grey">
          {LOAD_MORE_FAILED}
        </Text>
        <Button
          variant="link"
          size="sm"
          label="Tentar de novo"
          onPress={() => {
            void list.loadMore();
          }}
        />
      </View>
    ) : list.hasMore ? null : (
      <Text
        variant="bodySm"
        color="grey"
        align="center"
        style={styles.footer}
        testID="notificacoes-fim"
      >
        {NOTIFICATIONS_END}
      </Text>
    );

  return (
    <SafeAreaView
      style={styles.screen}
      edges={['top']}
      testID={variant === 'personal' ? 'tela-notificacoes-pessoal' : 'tela-notificacoes-criador'}
    >
      {variant === 'personal' ? (
        <ScreenHeader variant="back" title={NOTIFICATIONS_TITLE} onBack={back} />
      ) : (
        <View style={styles.header}>
          <Text variant="titleLg" accessibilityRole="header">
            {NOTIFICATIONS_TITLE}
          </Text>
        </View>
      )}
      <SectionList
        testID="notificacoes-lista"
        style={styles.flex}
        sections={list.status === 'ready' ? sections : []}
        keyExtractor={keyOf}
        renderItem={({ item }) => renderRow(item)}
        renderSectionHeader={({ section }) => (
          <Text
            variant="titleSm"
            accessibilityRole="header"
            style={styles.sectionTitle}
            testID={`secao-${section.key}`}
          >
            {section.title}
          </Text>
        )}
        stickySectionHeadersEnabled={false}
        ListEmptyComponent={emptyComponent}
        ListFooterComponent={footer ?? undefined}
        onEndReached={() => {
          if (list.hasMore && !list.loadMoreFailed) void list.loadMore();
        }}
        onEndReachedThreshold={0.5}
        refreshControl={
          <RefreshControl
            refreshing={list.refreshing}
            onRefresh={() => {
              marked.current = null;
              void list.refresh();
            }}
            tintColor={theme.colors.grey}
          />
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  flex: { flex: 1 },
  header: {
    minHeight: theme.layout.headerHeight,
    justifyContent: 'center',
    paddingHorizontal: theme.layout.screenX,
  },
  sectionTitle: {
    paddingHorizontal: theme.layout.screenX,
    paddingTop: theme.space[16],
    paddingBottom: theme.space[4],
  },
  skeletonRow: {
    minHeight: theme.layout.rowMinHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[12],
    paddingHorizontal: theme.layout.screenX,
  },
  skeletonTexts: { flex: 1, gap: theme.space[6] },
  footer: { paddingVertical: theme.space[24], alignItems: 'center' },
  footerRow: { flexDirection: 'row', justifyContent: 'center', gap: theme.space[8] },
});
