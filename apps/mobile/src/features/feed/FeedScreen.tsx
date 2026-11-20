import { FEED_WINDOW_HOURS_DEFAULT, feedWindowLabel } from '@sussurro/shared';
import {
  Button,
  CaughtUp,
  EmptyState,
  IconButton,
  Logo,
  PostSkeleton,
  Skeleton,
  Text,
  theme,
  TopTabs,
  useToast,
} from '@sussurro/ui';
import { router, useIsFocused } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { messageForError } from '../../lib/error-messages';
import { useAuth, useSignedInUser } from '../auth/AuthProvider';
import { PublishingBanners } from '../create/PublishingProvider';
import { ROUTES } from '../navigation/routes';
import { useNotifications } from '../notifications/NotificationsProvider';
import { fetchFeedPage } from '../posts/api';
import { isPublished, usePostStore, useVisibleIds } from '../posts/post-store';
import { PostCard } from '../posts/PostCard';
import { usePostPages } from '../posts/usePostPages';
import { ReelGridTile } from '../reels/ReelGridTile';
import { useFollowStore } from '../relations/follow-store';

type FeedTab = 'photo' | 'text' | 'reel';

const TABS = [
  { key: 'photo', label: 'Fotos', accessibilityLabel: 'Fotos' },
  { key: 'text', label: 'Textos', accessibilityLabel: 'Textos' },
  { key: 'reel', label: 'Reels', accessibilityLabel: 'Reels' },
] as const;

export const FEED_EMPTY_TITLE = 'Seu início está vazio';
export const FEED_ERROR_TITLE = 'Não foi possível carregar';
export const LOAD_MORE_FAILED = 'Não carregou.';

const BASE = ROUTES.personalHome;
/** Grade de reels (p08): 3 colunas 9:16. */
const REEL_COLUMNS = 3;

function GridSeparator() {
  return <View style={styles.separator} />;
}

/**
 * Tira as publicações dos criadores que a pessoa deixou de seguir nesta sessão (ux.md §12.2): saem
 * na hora, junto com a troca otimista do "Seguindo", sem buscar de novo. Se o `DELETE` falhar, o
 * `FollowStore` volta a `true` e elas voltam.
 */
function useWithoutUnfollowed(ids: readonly string[]): string[] {
  const posts = usePostStore();
  const follows = useFollowStore();
  const joinedIds = ids.join('|');
  // Uma string estável como snapshot: muda só quando alguma publicação sai ou volta.
  const getSnapshot = useCallback(() => {
    if (joinedIds === '') return '';
    return joinedIds
      .split('|')
      .filter((postId) => {
        const author = posts.get(postId)?.author;
        return !(author?.accountType === 'creator' && follows.get(author.handle) === false);
      })
      .join('|');
  }, [follows, joinedIds, posts]);
  const joined = useSyncExternalStore(follows.subscribe, getSnapshot, getSnapshot);
  return useMemo(() => (joined === '' ? [] : joined.split('|')), [joined]);
}

/**
 * Uma aba do feed: Fotos e Textos em lista; Reels em grade 3 colunas 9:16 (p08, 5.4). Paginação por
 * cursor e os estados do ux.md §5.1.
 */
function FeedList({ type, visible }: { type: FeedTab; visible: boolean }) {
  const user = useSignedInUser();
  const { api } = useAuth();
  const store = usePostStore();
  const toast = useToast();
  const { width } = useWindowDimensions();
  const focused = useIsFocused();
  const listRef = useRef<FlatList<string>>(null);
  // A versão do Início que a primeira página buscada já inclui (ux.md §12.2). A aba que monta agora
  // carrega do zero, então começa em dia.
  const loadedVersion = useRef(store.feedVersion);
  const fetchPage = useCallback(
    async (cursor?: string) => {
      const version = store.feedVersion;
      const page = await fetchFeedPage(api, type, cursor);
      if (cursor === undefined) loadedVersion.current = Math.max(loadedVersion.current, version);
      return page;
    },
    [api, store, type],
  );
  const onRefreshError = useCallback(
    (error: unknown) => {
      toast.show({ message: messageForError(error), variant: 'error' });
    },
    [toast],
  );
  const pages = usePostPages(fetchPage, { onRefreshError });
  // O feed só mostra o que está publicado (o servidor já garante; um reel em processamento ou com
  // falha nunca aparece fora do perfil do autor, MID-09).
  const ids = useWithoutUnfollowed(
    useVisibleIds(pages.ids, type === 'reel' ? isPublished : undefined),
  );
  const { prepend, refresh, status } = pages;
  const reel = type === 'reel';
  const tileWidth = (width - theme.layout.gridGap * (REEL_COLUMNS - 1)) / REEL_COLUMNS;

  // D9: o próprio post aparece no topo do feed assim que é publicado.
  useEffect(
    () =>
      store.onCreated((post) => {
        if (post.type === type && isPublished(post)) prepend(post.id);
      }),
    [prepend, store, type],
  );

  // Início desatualizado (seguiu ou conectou, ux.md §12.2): quando a aba volta a ficar em foco e
  // visível, busca a primeira página uma vez, sem o indicador do puxar e sem Toast na falha (a marca
  // fica para a próxima volta). Com a página nova, a lista volta ao topo, sem animação. Nunca
  // enquanto a pessoa está nela: só a mudança de foco, de aba ou do estado da lista dispara.
  // Com o puxar para atualizar em voo, a busca automática não começa: ela descartaria a resposta
  // do puxar e, se falhasse, deixaria o indicador preso. A marca fica para a próxima volta ao foco.
  const refreshRef = useRef({ refresh, pulling: pages.refreshing });
  useEffect(() => {
    refreshRef.current = { refresh, pulling: pages.refreshing };
  });
  const staleRefreshing = useRef(false);
  useEffect(() => {
    if (!focused || !visible || status !== 'ready' || staleRefreshing.current) return;
    if (refreshRef.current.pulling) return;
    if (store.feedVersion <= loadedVersion.current) return;
    staleRefreshing.current = true;
    void refreshRef.current.refresh({ silent: true }).then((replaced) => {
      staleRefreshing.current = false;
      if (replaced) listRef.current?.scrollToOffset({ offset: 0, animated: false });
    });
  }, [focused, status, store, visible]);

  const windowLabel = feedWindowLabel(pages.windowHours ?? FEED_WINDOW_HOURS_DEFAULT);
  const noOne =
    user.accountType === 'personal' && user.counts.connections === 0 && user.counts.creators === 0;

  const empty =
    pages.status === 'loading' ? (
      reel ? (
        <View style={[styles.grid, { gap: theme.layout.gridGap }]} testID={`feed-loading-${type}`}>
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} width={tileWidth} height={(tileWidth * 16) / 9} radius={0} />
          ))}
        </View>
      ) : (
        <View testID={`feed-loading-${type}`}>
          <PostSkeleton kind={type} />
          <PostSkeleton kind={type} />
          <PostSkeleton kind={type} />
        </View>
      )
    ) : pages.status === 'error' ? (
      <EmptyState
        icon="circle-alert"
        title={FEED_ERROR_TITLE}
        description={messageForError(pages.error)}
        primaryAction={{
          label: 'Tentar de novo',
          onPress: () => {
            void pages.reload();
          },
        }}
        testID={`feed-error-${type}`}
      />
    ) : noOne ? (
      <EmptyState
        icon="house"
        title={FEED_EMPTY_TITLE}
        description="Conecte-se ao vivo com quem você encontra ou siga criadores para ver publicações aqui."
        primaryAction={{
          label: 'Conectar ao vivo',
          onPress: () => {
            router.navigate(ROUTES.personalConnect);
          },
        }}
        secondaryAction={{
          label: 'Pesquisar criadores',
          onPress: () => {
            router.navigate(ROUTES.personalSearch);
          },
        }}
        testID={`feed-empty-${type}`}
      />
    ) : (
      // Sem posts na janela: só o "Você está em dia" (ux.md §5.1).
      <CaughtUp kind={type} windowLabel={windowLabel} testID={`caught-up-${type}`} />
    );

  const footer =
    ids.length === 0 ? null : pages.loadingMore ? (
      <ActivityIndicator style={styles.footer} color={theme.colors.grey} />
    ) : pages.loadMoreFailed ? (
      <View style={[styles.footer, styles.footerRow]} testID={`feed-more-failed-${type}`}>
        <Text variant="bodySm" color="grey">
          {LOAD_MORE_FAILED}
        </Text>
        <Button
          variant="link"
          size="sm"
          label="Tentar de novo"
          onPress={() => {
            void pages.loadMore();
          }}
        />
      </View>
    ) : pages.caughtUp ? (
      <CaughtUp kind={type} windowLabel={windowLabel} testID={`caught-up-${type}`} />
    ) : null;

  return (
    <FlatList
      ref={listRef}
      testID={`feed-list-${type}`}
      style={[styles.flex, !visible && styles.hidden]}
      data={pages.status === 'ready' ? ids : []}
      keyExtractor={(postId) => postId}
      {...(reel
        ? {
            numColumns: REEL_COLUMNS,
            columnWrapperStyle: { gap: theme.layout.gridGap },
            ItemSeparatorComponent: GridSeparator,
          }
        : {})}
      renderItem={({ item }) =>
        reel ? (
          <ReelGridTile postId={item} width={tileWidth} base={BASE} />
        ) : (
          <PostCard postId={item} base={BASE} />
        )
      }
      ListEmptyComponent={empty}
      ListFooterComponent={footer ?? undefined}
      onEndReached={() => {
        if (pages.hasMore && !pages.loadMoreFailed) void pages.loadMore();
      }}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={pages.refreshing}
          onRefresh={() => {
            void pages.refresh();
          }}
          tintColor={theme.colors.grey}
        />
      }
    />
  );
}

/**
 * Início (p06–p08), só conta pessoal: Fotos, Textos e Reels em ordem cronológica, terminando em
 * "Você está em dia" (histórias 2.5 e 5.4). O coração abre as Notificações, com o ponto azul
 * quando há não lidas (6.2).
 */
export function FeedScreen() {
  const [tab, setTab] = useState<FeedTab>('photo');
  const { unreadCount } = useNotifications();
  const hasUnread = unreadCount > 0;
  const [visited, setVisited] = useState<ReadonlySet<FeedTab>>(() => new Set(['photo']));

  const change = (next: FeedTab) => {
    setTab(next);
    setVisited((current) => (current.has(next) ? current : new Set([...current, next])));
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID="tela-inicio">
      <View style={styles.header}>
        <Logo
          variant="lockup"
          size={24}
          accessibilityRole="header"
          accessibilityLabel="Sussurro, início"
        />
        <IconButton
          icon="heart"
          accessibilityLabel={hasUnread ? 'Notificações, há novidades' : 'Notificações'}
          dot={hasUnread}
          testID="coracao"
          onPress={() => {
            router.push(ROUTES.personalNotifications);
          }}
        />
      </View>
      <TopTabs tabs={TABS} value={tab} onChange={change} testID="feed-tabs" />
      <PublishingBanners />
      {visited.has('photo') ? <FeedList type="photo" visible={tab === 'photo'} /> : null}
      {visited.has('text') ? <FeedList type="text" visible={tab === 'text'} /> : null}
      {visited.has('reel') ? <FeedList type="reel" visible={tab === 'reel'} /> : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  flex: { flex: 1 },
  hidden: { display: 'none' },
  header: {
    height: theme.layout.headerHeight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: theme.layout.screenX,
    paddingRight: theme.space[4],
  },
  grid: { flexDirection: 'row' },
  separator: { height: theme.layout.gridGap },
  footer: { paddingVertical: theme.space[16], alignItems: 'center' },
  footerRow: { flexDirection: 'row', justifyContent: 'center', gap: theme.space[8] },
});
