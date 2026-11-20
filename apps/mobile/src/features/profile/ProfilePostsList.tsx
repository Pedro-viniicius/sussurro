import {
  Button,
  EmptyState,
  type IconName,
  PhotoTile,
  PostSkeleton,
  Skeleton,
  Text,
  theme,
  TopTabs,
} from '@sussurro/ui';
import { router, useIsFocused } from 'expo-router';
import { type ReactElement, useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  RefreshControl,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';

import { useAuth } from '../auth/AuthProvider';
import { ROUTES, type TabBase } from '../navigation/routes';
import { fetchProfilePosts } from '../posts/api';
import { postHref } from '../posts/navigation';
import { isPublished, usePost, usePostStore, useVisibleIds } from '../posts/post-store';
import { PostCard } from '../posts/PostCard';
import { useDeletePost } from '../posts/useDeletePost';
import { usePostPages } from '../posts/usePostPages';
import { ReelGridTile } from '../reels/ReelGridTile';
import { useProcessingReelsPoll } from '../reels/useProcessingReelsPoll';

export type ProfileTab = 'photos' | 'texts' | 'reels';

const TABS = [
  { key: 'photos', icon: 'grid-3x3', accessibilityLabel: 'Fotos' },
  { key: 'texts', icon: 'align-left', accessibilityLabel: 'Textos' },
  { key: 'reels', icon: 'square-play', accessibilityLabel: 'Reels' },
] as const satisfies readonly { key: ProfileTab; icon: IconName; accessibilityLabel: string }[];

const OWN_EMPTY: Record<ProfileTab, { icon: IconName; title: string }> = {
  photos: { icon: 'image', title: 'Compartilhe sua primeira foto' },
  texts: { icon: 'align-left', title: 'Escreva seu primeiro texto' },
  reels: { icon: 'square-play', title: 'Compartilhe seu primeiro reel' },
};

const OTHER_EMPTY: Record<ProfileTab, { icon: IconName; title: string }> = {
  photos: { icon: 'image', title: 'Nenhuma foto ainda.' },
  texts: { icon: 'align-left', title: 'Nenhum texto ainda.' },
  reels: { icon: 'square-play', title: 'Nenhum reel ainda.' },
};

const COLUMNS = 3;

function PhotoGridTile({ postId, width, base }: { postId: string; width: number; base: TabBase }) {
  const post = usePost(postId);
  const confirmDelete = useDeletePost();
  if (post === undefined) return null;
  const cover = [...post.media].sort((a, b) => a.position - b.position)[0];
  const status =
    post.status === 'processing' || post.status === 'draft'
      ? 'processing'
      : post.status === 'failed'
        ? 'failed'
        : 'ready';
  const count = post.media.length;
  const onPress =
    status === 'ready'
      ? () => {
          router.push(postHref(base, post.id));
        }
      : status === 'failed'
        ? () => {
            // Falhou no processamento: a única ação é excluir (e publicar de novo pelo Criar).
            confirmDelete(post.id);
          }
        : undefined;
  return (
    <PhotoTile
      image={{ key: cover?.id ?? post.id, uri: cover?.thumbUrl ?? cover?.url ?? null }}
      width={width}
      multiple={count > 1}
      status={status}
      {...(onPress === undefined ? {} : { onPress })}
      accessibilityLabel={
        count > 1 ? `Publicação com ${String(count)} fotos` : 'Publicação com foto'
      }
      testID={`tile-${post.id}`}
    />
  );
}

export interface ProfilePostsListProps {
  handle: string;
  /** Perfil próprio: estados `processing`/`failed` e posts novos no topo. */
  own: boolean;
  /** Aba de origem (`/pessoal/perfil`, `/pessoal/inicio`…) para abrir o detalhe. */
  base: TabBase;
  /** Cabeçalho do perfil (rola junto com a lista). */
  header: ReactElement;
  /** Puxar para atualizar também atualiza o cabeçalho (números). */
  onRefreshHeader?: () => Promise<unknown>;
}

/**
 * Abas do perfil (histórias 2.6 e 5.4): grade de fotos 3:4, lista de textos e grade de reels 9:16,
 * com paginação por cursor. O dono vê os posts em `processing` e `failed` (MID-09, 5.6); no perfil
 * de outra conta, só o publicado.
 */
export function ProfilePostsList({
  handle,
  own,
  base,
  header,
  onRefreshHeader,
}: ProfilePostsListProps) {
  const { api } = useAuth();
  const store = usePostStore();
  const { width } = useWindowDimensions();
  const [tab, setTab] = useState<ProfileTab>('photos');
  const [textsVisited, setTextsVisited] = useState(false);
  const [reelsVisited, setReelsVisited] = useState(false);

  const fetchPhotos = useCallback(
    (cursor?: string) => fetchProfilePosts(api, handle, 'photo', cursor),
    [api, handle],
  );
  const fetchTexts = useCallback(
    (cursor?: string) => fetchProfilePosts(api, handle, 'text', cursor),
    [api, handle],
  );
  const fetchReels = useCallback(
    (cursor?: string) => fetchProfilePosts(api, handle, 'reel', cursor),
    [api, handle],
  );
  const photos = usePostPages(fetchPhotos);
  const texts = usePostPages(fetchTexts, { enabled: textsVisited });
  const reels = usePostPages(fetchReels, { enabled: reelsVisited });
  const photoIds = useVisibleIds(photos.ids);
  const textIds = useVisibleIds(texts.ids);
  // Reel em processamento ou com falha nunca aparece fora do perfil do autor (MID-09, 5.3 CA3).
  const reelIds = useVisibleIds(reels.ids, own ? undefined : isPublished);
  // O tile "Processando" de um reel de outra sessão se atualiza sozinho (ux.md §12.3): só no próprio
  // perfil, com a tela em foco e a aba Reels visível (o app em primeiro plano, o hook confere).
  const focused = useIsFocused();
  useProcessingReelsPoll(reelIds, own && focused && tab === 'reels');
  const prependPhoto = photos.prepend;
  const prependText = texts.prepend;
  const prependReel = reels.prepend;

  useEffect(() => {
    if (!own) return undefined;
    return store.onCreated((post) => {
      if (post.type === 'photo') prependPhoto(post.id);
      if (post.type === 'text') prependText(post.id);
      // O reel entra já em processamento (tile "Processando") e depois fica pronto no lugar.
      if (post.type === 'reel') prependReel(post.id);
    });
  }, [own, prependPhoto, prependReel, prependText, store]);

  const changeTab = (next: ProfileTab) => {
    setTab(next);
    if (next === 'texts') setTextsVisited(true);
    if (next === 'reels') setReelsVisited(true);
  };

  const current = tab === 'texts' ? texts : tab === 'reels' ? reels : photos;
  const ids = tab === 'texts' ? textIds : tab === 'reels' ? reelIds : photoIds;
  const grid = tab !== 'texts';
  const tileWidth = (width - theme.layout.gridGap * (COLUMNS - 1)) / COLUMNS;
  const tileHeight = tab === 'reels' ? (tileWidth * 16) / 9 : (tileWidth * 4) / 3;

  const openCreate = () => {
    router.push(tab === 'reels' ? `${ROUTES.create}?modo=reel` : ROUTES.create);
  };

  const refresh = async () => {
    await Promise.all([onRefreshHeader?.().catch(() => undefined), current.refresh()]);
  };

  const listHeader = (
    <View>
      {header}
      <View style={styles.tabs}>
        <TopTabs
          tabs={TABS}
          value={tab}
          onChange={changeTab}
          variant="icon"
          testID="profile-tabs"
        />
      </View>
    </View>
  );

  const empty =
    current.status === 'loading' ? (
      grid ? (
        <View style={[styles.grid, { gap: theme.layout.gridGap }]} testID="perfil-carregando">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} width={tileWidth} height={tileHeight} radius={0} />
          ))}
        </View>
      ) : (
        <View testID="perfil-carregando">
          <PostSkeleton kind="text" />
          <PostSkeleton kind="text" />
        </View>
      )
    ) : current.status === 'error' ? (
      <EmptyState
        icon="circle-alert"
        title="Não foi possível carregar"
        primaryAction={{
          label: 'Tentar de novo',
          onPress: () => {
            void current.reload();
          },
        }}
      />
    ) : (
      <EmptyState
        icon={(own ? OWN_EMPTY : OTHER_EMPTY)[tab].icon}
        title={(own ? OWN_EMPTY : OTHER_EMPTY)[tab].title}
        {...(own ? { primaryAction: { label: 'Nova publicação', onPress: openCreate } } : {})}
        testID={`perfil-vazio-${tab}`}
      />
    );

  const footer =
    ids.length === 0 ? null : current.loadingMore ? (
      <ActivityIndicator style={styles.footer} color={theme.colors.grey} />
    ) : current.loadMoreFailed ? (
      <View style={[styles.footer, styles.footerRow]}>
        <Text variant="bodySm" color="grey">
          Não carregou.
        </Text>
        <Button
          variant="link"
          size="sm"
          label="Tentar de novo"
          onPress={() => {
            void current.loadMore();
          }}
        />
      </View>
    ) : null;

  return (
    <FlatList
      key={tab === 'photos' ? 'grade' : tab === 'reels' ? 'reels' : 'lista'}
      testID={`perfil-lista-${tab}`}
      data={current.status === 'ready' ? ids : []}
      numColumns={grid ? COLUMNS : 1}
      {...(grid ? { columnWrapperStyle: { gap: theme.layout.gridGap } } : {})}
      keyExtractor={(postId) => postId}
      ListHeaderComponent={listHeader}
      ListEmptyComponent={empty}
      ListFooterComponent={footer ?? undefined}
      ItemSeparatorComponent={grid ? GridSeparator : undefined}
      renderItem={({ item }) =>
        tab === 'photos' ? (
          <PhotoGridTile postId={item} width={tileWidth} base={base} />
        ) : tab === 'reels' ? (
          <ReelGridTile postId={item} width={tileWidth} base={base} />
        ) : (
          <PostCard postId={item} base={base} />
        )
      }
      onEndReached={() => {
        if (current.hasMore && !current.loadMoreFailed) {
          void current.loadMore();
        }
      }}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={current.refreshing}
          onRefresh={() => {
            void refresh();
          }}
          tintColor={theme.colors.grey}
        />
      }
    />
  );
}

function GridSeparator() {
  return <View style={styles.separator} />;
}

const styles = StyleSheet.create({
  tabs: { marginTop: theme.space[16] },
  grid: { flexDirection: 'row' },
  separator: { height: theme.layout.gridGap },
  footer: { paddingVertical: theme.space[16], alignItems: 'center' },
  footerRow: { flexDirection: 'row', justifyContent: 'center', gap: theme.space[8] },
});
