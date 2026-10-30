import {
  CREATOR_SEARCH_MIN_LENGTH,
  type CreatorSearchItem,
  CreatorSearchTermSchema,
  isCreatorSearchReady,
  normalizeCreatorSearch,
} from '@sussurro/shared';
import {
  Button,
  followButtonLabel,
  formatStatCount,
  SearchBar,
  STAT_LABELS,
  statLabel,
  Text,
  theme,
  UserRow,
} from '@sussurro/ui';
import { router } from 'expo-router';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { messageForError } from '../../lib/error-messages';
import { timing } from '../../lib/timing';
import { useAuth, useSignedInUser } from '../auth/AuthProvider';
import { ROUTES } from '../navigation/routes';
import { profileHref } from '../posts/navigation';
import { useHiddenAuthors } from '../posts/post-store';
import { searchCreators } from '../relations/api';
import { useFollowing, useFollowStore } from '../relations/follow-store';
import { useFollowToggle } from '../relations/useFollowToggle';

/** Textos da tela Pesquisar (ux.md §5.1, D-UX5). */
export const SEARCH_HINT = 'Digite o @ de um criador.';
export const SEARCH_MIN_HINT = 'Digite pelo menos 3 letras.';
/** Sempre a mesma mensagem sem criador: nunca diz se o @ é de conta pessoal (A-04, BUS-05). */
export const SEARCH_EMPTY =
  'Nenhum criador com esse @. Contas pessoais não aparecem na busca: elas só se conectam ao vivo.';

const BASE = ROUTES.personalSearch;

interface SearchResponse {
  term: string;
  attempt: number;
  items?: CreatorSearchItem[];
  error?: unknown;
}

/** "Estúdio Aurora · 5.067 seguidores" (p15). */
function subtitleOf(item: CreatorSearchItem): string {
  const count = item.followersCount;
  return `${item.name} · ${formatStatCount(count)} ${statLabel(count, STAT_LABELS.followers)}`;
}

/** O que dizer com o termo ainda não pronto para a API (BUS-11). */
function hintFor(raw: string, term: string): string {
  if (term === '') return SEARCH_HINT;
  if (term.length < CREATOR_SEARCH_MIN_LENGTH) return SEARCH_MIN_HINT;
  const parsed = CreatorSearchTermSchema.safeParse(raw);
  return parsed.success ? SEARCH_MIN_HINT : (parsed.error.issues[0]?.message ?? SEARCH_MIN_HINT);
}

function CreatorRow({ item }: { item: CreatorSearchItem }) {
  const user = useSignedInUser();
  const following = useFollowing(item.handle, item.followedByMe);
  const toggle = useFollowToggle();
  return (
    <UserRow
      handle={item.handle}
      name={item.name}
      avatarUri={item.avatarUrl}
      subtitle={subtitleOf(item)}
      onPress={() => {
        router.push(profileHref(BASE, item.handle, user));
      }}
      action={
        <Button
          variant={following ? 'secondary' : 'primary'}
          size="sm"
          label={following ? 'Seguindo' : 'Seguir'}
          accessibilityLabel={followButtonLabel(item.handle, following)}
          onPress={() => {
            void toggle(item.handle, following);
          }}
        />
      }
    />
  );
}

/**
 * Pesquisar (p15, histórias 3.1 e 3.2), só conta pessoal: busca pelo @ com pausa na digitação,
 * sem sugestões. Com menos de 3 letras (ou com caracteres fora do @) o app nem chama a API (BUS-11).
 * Sem criador, a mesma mensagem para qualquer busca (um @ pessoal e um inexistente são iguais).
 * Erro e 429: linha com "Tentar de novo".
 */
export function SearchScreen() {
  const { api } = useAuth();
  const follows = useFollowStore();
  const hidden = useHiddenAuthors();
  const [text, setText] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [response, setResponse] = useState<SearchResponse | null>(null);

  const term = normalizeCreatorSearch(text);
  const ready = isCreatorSearchReady(text);

  useEffect(() => {
    if (!ready) return undefined;
    let active = true;
    const timer = setTimeout(() => {
      searchCreators(api, term).then(
        (result) => {
          if (!active) return;
          follows.merge(result.items.map((item) => [item.handle, item.followedByMe] as const));
          setResponse({ term, attempt, items: result.items });
        },
        (error: unknown) => {
          if (active) setResponse({ term, attempt, error });
        },
      );
    }, timing.searchDebounceMs);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, attempt, follows, ready, term]);

  const current =
    ready && response !== null && response.term === term && response.attempt === attempt
      ? response
      : null;
  const loading = ready && current === null;
  // Enquanto o termo novo carrega, a lista anterior continua (sem piscar).
  const shown = ready ? (current ?? response) : null;
  const items = useMemo(
    () => (shown?.items ?? []).filter((item) => !hidden.has(item.handle)),
    [hidden, shown],
  );

  let body: ReactNode;
  if (!ready) {
    body = (
      <Text variant="bodySm" color="grey" align="center" style={styles.message} testID="busca-dica">
        {hintFor(text, term)}
      </Text>
    );
  } else if (current?.error !== undefined) {
    body = (
      <View style={styles.errorRow} testID="busca-erro">
        <Text variant="bodySm" color="grey" align="center">
          {messageForError(current.error)}
        </Text>
        <Button
          variant="link"
          size="sm"
          label="Tentar de novo"
          onPress={() => {
            setAttempt((value) => value + 1);
          }}
        />
      </View>
    );
  } else if (current !== null && items.length === 0) {
    body = (
      <Text
        variant="bodySm"
        color="grey"
        align="center"
        style={styles.message}
        testID="busca-vazia"
      >
        {SEARCH_EMPTY}
      </Text>
    );
  } else {
    body = (
      <FlatList
        testID="busca-resultados"
        style={styles.flex}
        data={items}
        keyExtractor={(item) => item.handle}
        renderItem={({ item }) => <CreatorRow item={item} />}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      />
    );
  }

  return (
    <SafeAreaView style={styles.screen} edges={['top']} testID="tela-pesquisar">
      <View style={styles.header}>
        <SearchBar value={text} onChangeText={setText} loading={loading} />
      </View>
      {body}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.colors.white },
  flex: { flex: 1 },
  header: { paddingHorizontal: theme.layout.screenX, paddingVertical: theme.space[8] },
  message: { paddingHorizontal: theme.space[32], paddingVertical: theme.space[24] },
  errorRow: {
    alignItems: 'center',
    gap: theme.space[4],
    paddingHorizontal: theme.space[32],
    paddingVertical: theme.space[24],
  },
});
