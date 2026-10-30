import {
  Button,
  EmptyState,
  type EmptyStateProps,
  Icon,
  ScreenHeader,
  Skeleton,
  Text,
  theme,
} from '@sussurro/ui';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { useCursorList } from './useCursorList';
import { messageForError } from '../../lib/error-messages';

/** Nota das listas privadas (ux.md §4.8, 3.6 CA1). */
export const OWN_LIST_NOTE = 'Só você vê esta lista.';
export const LIST_ERROR_TITLE = 'Não foi possível carregar';
export const LOAD_MORE_FAILED = 'Não carregou.';

function back() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function RowSkeleton() {
  return (
    <View style={styles.skeletonRow}>
      <Skeleton width={44} height={44} radius={22} />
      <View style={styles.skeletonTexts}>
        <Skeleton width="40%" height={14} />
        <Skeleton width="60%" height={12} />
      </View>
    </View>
  );
}

export interface OwnListScreenProps<T> {
  title: string;
  testID: string;
  list: ReturnType<typeof useCursorList<T>>;
  /** Itens já filtrados (bloqueados nesta sessão, deixou de seguir…). */
  visibleItems: readonly T[];
  keyOf: (item: T) => string;
  renderRow: (item: T) => ReactNode;
  empty: Omit<EmptyStateProps, 'testID'>;
}

/**
 * Lista privada do dono (ux.md §4.8): cabeçalho com voltar, a nota "Só você vê esta lista." com o
 * cadeado, linhas paginadas por cursor e os estados do §5.1 (skeleton de linhas, EmptyState com
 * ação, "Tentar de novo" e "Não carregou" na página seguinte).
 */
export function OwnListScreen<T>({
  title,
  testID,
  list,
  visibleItems,
  keyOf,
  renderRow,
  empty,
}: OwnListScreenProps<T>) {
  const note = (
    <View style={styles.note} testID={`${testID}-nota`}>
      <Icon name="lock" size={16} color="grey" />
      <Text variant="bodySm" color="grey">
        {OWN_LIST_NOTE}
      </Text>
    </View>
  );

  const emptyComponent =
    list.status === 'loading' ? (
      <View testID={`${testID}-carregando`}>
        <RowSkeleton />
        <RowSkeleton />
        <RowSkeleton />
      </View>
    ) : list.status === 'error' ? (
      <EmptyState
        icon="circle-alert"
        title={LIST_ERROR_TITLE}
        description={messageForError(list.error)}
        primaryAction={{
          label: 'Tentar de novo',
          onPress: () => {
            void list.reload();
          },
        }}
        testID={`${testID}-erro`}
      />
    ) : (
      <EmptyState {...empty} testID={`${testID}-vazia`} />
    );

  const footer =
    visibleItems.length === 0 ? null : list.loadingMore ? (
      <ActivityIndicator style={styles.footer} color={theme.colors.grey} />
    ) : list.loadMoreFailed ? (
      <View style={[styles.footer, styles.footerRow]} testID={`${testID}-mais-falhou`}>
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
    ) : null;

  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID={testID}>
      <ScreenHeader variant="back" title={title} onBack={back} />
      <FlatList
        testID={`${testID}-lista`}
        style={styles.flex}
        data={list.status === 'ready' ? visibleItems : []}
        keyExtractor={keyOf}
        renderItem={({ item }) => <>{renderRow(item)}</>}
        ListHeaderComponent={note}
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
  note: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[6],
    paddingHorizontal: theme.layout.screenX,
    paddingVertical: theme.space[12],
  },
  skeletonRow: {
    minHeight: theme.layout.rowMinHeight,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space[12],
    paddingHorizontal: theme.layout.screenX,
  },
  skeletonTexts: { flex: 1, gap: theme.space[6] },
  footer: { paddingVertical: theme.space[16], alignItems: 'center' },
  footerRow: { flexDirection: 'row', justifyContent: 'center', gap: theme.space[8] },
});
