import { COMMENT_MAX_LENGTH, countChars, feedWindowLabel } from '@sussurro/shared';
import {
  CaughtUp,
  type CommentThreadView,
  CommentSkeleton,
  CommentsSheet,
  type CreateMode,
  IconButton,
  Logo,
  MediaPickerGrid,
  ModePill,
  PhotoTile,
  PostPhoto,
  PostSkeleton,
  PostText,
  ProfileHeader,
  Text,
  theme,
  TopTabs,
  UploadBanner,
} from '@sussurro/ui';
import { type ReactNode, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';

import { catalogImages } from './images';

const noop = () => undefined;
const MIN = 60_000;
const HOUR = 60 * MIN;

/** Relógio fixo do catálogo: os tempos relativos ficam iguais a cada abertura. */
const NOW = new Date(2026, 9, 29, 10, 0, 0);
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const [azul, verde, areia] = catalogImages;
const IMAGES = [azul, verde, areia];

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.block}>
      <Text variant="titleSm" accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function Caption({ children }: { children: string }) {
  return (
    <Text variant="caption" color="grey">
      {children}
    </Text>
  );
}

/** O post ocupa a largura da tela; no catálogo, a da área de conteúdo (sem a margem). */
function useContentWidth(): number {
  const { width } = useWindowDimensions();
  return Math.max(0, width - 2 * theme.layout.screenX);
}

function LikeDemo({ children }: { children: (liked: boolean, toggle: () => void) => ReactNode }) {
  const [liked, setLiked] = useState(false);
  return (
    <>
      {children(liked, () => {
        setLiked((value) => !value);
      })}
    </>
  );
}

function PostPhotoBlock() {
  const width = useContentWidth();
  return (
    <Block title="PostPhoto">
      <Caption>Carrossel 1/3 com setas e pontos; curtir alterna (otimista).</Caption>
      <LikeDemo>
        {(liked, toggle) => (
          <PostPhoto
            testID="catalog-post-photo"
            width={width}
            author={{ handle: 'marinac', name: 'Marina Costa' }}
            relation="connection"
            images={IMAGES}
            caption="Domingo de manhã no Passaúna. Ninguém por perto, só o barulho da água."
            likeCount={liked ? 7 : 6}
            liked={liked}
            commentCount={2}
            publishedAt={ago(18 * MIN)}
            now={NOW}
            onLike={toggle}
            onOpenComments={noop}
            onOpenAuthor={noop}
          />
        )}
      </LikeDemo>
      <Caption>Uma foto, criador, curtido, 1 curtida e 1 comentário, "Ontem".</Caption>
      <PostPhoto
        width={width}
        author={{ handle: 'cozinhadabia', name: 'Cozinha da Bia' }}
        relation="creator"
        images={[areia]}
        caption="Pão de fermentação natural."
        likeCount={1}
        liked
        commentCount={1}
        publishedAt={new Date(2026, 9, 28, 8, 0)}
        now={NOW}
        onLike={noop}
        onOpenComments={noop}
      />
      <Caption>
        Próprio post (⋯ Excluir), visto pelo criador: sem coração (A-06); 0 curtidas.
      </Caption>
      <PostPhoto
        width={width}
        author={{ handle: 'trilhasdosul', name: 'Trilhas do Sul' }}
        relation="self"
        images={[verde]}
        likeCount={0}
        liked={false}
        commentCount={0}
        publishedAt={new Date(2026, 9, 27, 18, 0)}
        now={NOW}
        canLike={false}
        onOpenComments={noop}
        onMore={noop}
      />
      <Caption>Carregando (sem URL) e foto que falhou (toque tenta de novo).</Caption>
      <View style={styles.row}>
        <PostPhoto
          width={(width - theme.space[8]) / 2}
          author={{ handle: 'juprado' }}
          relation="connection"
          images={[{ key: 'catalogo-carregando', uri: null }]}
          likeCount={3}
          liked={false}
          commentCount={0}
          publishedAt={ago(3 * HOUR)}
          now={NOW}
        />
        <PostPhoto
          width={(width - theme.space[8]) / 2}
          author={{ handle: 'erica' }}
          relation="connection"
          images={[{ key: 'catalogo-falha', uri: 'https://invalido.local/foto.jpg' }]}
          likeCount={3}
          liked={false}
          commentCount={0}
          publishedAt={ago(3 * HOUR)}
          now={NOW}
        />
      </View>
    </Block>
  );
}

const TEXTS = [
  {
    handle: 'juprado',
    name: 'Juliana Prado',
    text: 'Alguém mais tentou ficar uma semana sem abrir o celular antes do café? Dia 3 e já sinto diferença.',
    at: ago(40 * MIN),
    likes: 4,
    comments: 1,
  },
  {
    handle: 'leituralenta',
    name: 'Clara Moura',
    text: 'Comecei Grande Sertão: Veredas pela segunda vez. Desta vez, dez páginas por dia e nenhuma meta além disso.',
    at: ago(3 * HOUR),
    likes: 61,
    comments: 0,
  },
  {
    handle: 'tomas.o',
    name: 'Tomás Oliveira',
    text: 'Jantar lá em casa sexta. Quem estava no aniversário da Marina já está convidado.',
    at: ago(6 * HOUR),
    likes: 3,
    comments: 0,
  },
] as const;

function PostTextBlock() {
  return (
    <Block title="PostText">
      <Caption>Thread de textos (p07): tempo curto, números ao lado dos ícones, 0 visível.</Caption>
      <View style={styles.bleed}>
        {TEXTS.map((item, index) => (
          <LikeDemo key={item.handle}>
            {(liked, toggle) => (
              <PostText
                testID={`catalog-post-text-${String(index)}`}
                author={{ handle: item.handle, name: item.name }}
                relation="connection"
                text={item.text}
                publishedAt={item.at}
                now={NOW}
                likeCount={item.likes + (liked ? 1 : 0)}
                liked={liked}
                commentCount={item.comments}
                onLike={toggle}
                onComment={noop}
                onOpen={noop}
                onOpenAuthor={noop}
              />
            )}
          </LikeDemo>
        ))}
        <PostText
          author={{ handle: 'cozinhadabia', name: 'Cozinha da Bia' }}
          relation="self"
          text="Receita do pão: 500 g de farinha, 350 ml de água, 100 g de levain e 10 g de sal."
          publishedAt={new Date(2026, 9, 28, 20, 0)}
          now={NOW}
          likeCount={97}
          liked={false}
          commentCount={0}
          canLike={false}
          onComment={noop}
          onMore={noop}
        />
      </View>
      <Caption>Último item: próprio post visto pelo criador (coração só como número, ⋯).</Caption>
    </Block>
  );
}

const THREADS: CommentThreadView[] = [
  {
    id: 'c1',
    parentId: null,
    author: { handle: 'lucasf', name: 'Lucas Ferreira', profileVisible: true },
    body: 'Que luz bonita!',
    createdAt: ago(2 * HOUR),
    canDelete: false,
    replies: [
      {
        id: 'c2',
        parentId: 'c1',
        author: { handle: 'marinac', name: 'Marina Costa', profileVisible: true },
        body: 'Obrigada!',
        createdAt: ago(HOUR),
        canDelete: true,
      },
    ],
  },
  {
    id: 'c3',
    parentId: null,
    author: { handle: 'rafa.dias', name: 'Rafael Dias', profileVisible: false },
    body: 'Fui lá no sábado, estava cheio. (@ sem link: perfil não visível)',
    createdAt: ago(30 * MIN),
    canDelete: false,
    replies: [],
  },
  {
    id: 'c4',
    parentId: null,
    author: { handle: 'helena', name: 'Helena Souza', profileVisible: true },
    body: 'Enviando…',
    createdAt: ago(0),
    canDelete: true,
    status: 'sending',
    replies: [],
  },
  {
    id: 'c5',
    parentId: null,
    author: { handle: 'helena', name: 'Helena Souza', profileVisible: true },
    body: 'Este não foi.',
    createdAt: ago(0),
    canDelete: true,
    status: 'failed',
    replies: [],
  },
];

function SheetFrame({ children, height = 520 }: { children: ReactNode; height?: number }) {
  return <View style={[styles.sheet, { height }]}>{children}</View>;
}

function CommentsBlock() {
  const common = {
    onRetry: noop,
    hasMore: false,
    onLoadMore: noop,
    onClose: noop,
    canReply: true,
    currentUser: { handle: 'helena', name: 'Helena Souza' },
    onSubmit: noop,
    onDelete: noop,
    onRetrySend: noop,
    onOpenAuthor: noop,
    maxLength: COMMENT_MAX_LENGTH,
    countFn: countChars,
    now: NOW,
  };
  return (
    <Block title="CommentsSheet">
      <Caption>Folha com respostas recuadas, enviando (50%), "Não publicado" e "Ver mais".</Caption>
      <SheetFrame>
        <CommentsSheet
          {...common}
          testID="catalog-comments"
          threads={THREADS}
          status="ready"
          hasMore
          canComment
        />
      </SheetFrame>
      <Caption>Criador no próprio post (A-06): sem campo até tocar em "Responder".</Caption>
      <SheetFrame height={300}>
        <CommentsSheet
          {...common}
          threads={THREADS.slice(0, 1)}
          status="ready"
          canComment={false}
        />
      </SheetFrame>
      <Caption>Carregando, erro e vazio.</Caption>
      <SheetFrame height={260}>
        <CommentsSheet {...common} threads={[]} status="loading" canComment />
      </SheetFrame>
      <SheetFrame height={240}>
        <CommentsSheet {...common} threads={[]} status="error" canComment={false} />
      </SheetFrame>
      <SheetFrame height={240}>
        <CommentsSheet {...common} threads={[]} status="ready" canComment />
      </SheetFrame>
    </Block>
  );
}

function CreateBlocks() {
  const width = useContentWidth();
  const [mode, setMode] = useState<CreateMode>('photo');
  const [selected, setSelected] = useState<string[]>([azul.key, areia.key]);
  // Seis fotos "trazidas do seletor": as três paisagens, duas vezes.
  const items = [...IMAGES, ...IMAGES].map((image, index) => ({
    key: index < IMAGES.length ? image.key : `${image.key}-2`,
    uri: image.uri ?? '',
  }));
  return (
    <>
      <Block title="ModePill">
        <View style={styles.pillStage}>
          <ModePill value={mode} onChange={setMode} testID="catalog-mode-pill" />
        </View>
        <Caption>FOTO, TEXTO e REEL (Fase 5).</Caption>
      </Block>
      <Block title="MediaPickerGrid">
        <MediaPickerGrid
          testID="catalog-media-picker"
          width={width}
          items={items}
          selected={selected}
          onAdd={noop}
          onToggle={(key) => {
            setSelected((current) =>
              current.includes(key)
                ? current.filter((item) => item !== key)
                : current.length >= 4
                  ? current
                  : [...current, key],
            );
          }}
        />
        <Caption>Seleção numerada na ordem; a 5ª é recusada (o app mostra o Toast).</Caption>
      </Block>
      <Block title="UploadBanner">
        <View style={styles.bleed}>
          <UploadBanner
            status="uploading"
            done={1}
            total={3}
            thumbUri={azul.uri}
            testID="catalog-upload"
          />
          <UploadBanner status="processing" thumbUri={verde.uri} />
          <UploadBanner status="failed" thumbUri={areia.uri} onRetry={noop} onDiscard={noop} />
        </View>
      </Block>
    </>
  );
}

function ProfileBlocks() {
  const width = useContentWidth();
  const tile = (width - 2 * theme.layout.gridGap) / 3;
  return (
    <>
      <Block title="PhotoTile">
        <View style={[styles.row, { gap: theme.layout.gridGap }]}>
          <PhotoTile
            image={azul}
            width={tile}
            multiple
            onPress={noop}
            accessibilityLabel="Foto"
            testID="catalog-tile"
          />
          <PhotoTile image={verde} width={tile} status="processing" accessibilityLabel="Foto" />
          <PhotoTile
            image={areia}
            width={tile}
            status="failed"
            onPress={noop}
            accessibilityLabel="Foto"
          />
        </View>
        <Caption>3:4; várias fotos; processando e falhou (só o dono vê).</Caption>
      </Block>
      <Block title="ProfileHeader (outra conta)">
        <View style={styles.bleed}>
          <ProfileHeader
            mode="other"
            handle="trilhasdosul"
            name="Rafael Duarte"
            bio="Trilhas e acampamentos no Sul do Brasil."
            counts={{ accountType: 'creator', posts: 5, followers: 8903 }}
            onBack={noop}
            testID="catalog-profile-other"
          />
        </View>
      </Block>
      <Block title="Skeleton">
        <View style={styles.bleed}>
          <PostSkeleton kind="text" />
          <CommentSkeleton />
        </View>
      </Block>
      <Block title="IconButton">
        <View style={styles.row}>
          <IconButton icon="heart" accessibilityLabel="Notificações" onPress={noop} />
          <IconButton icon="ellipsis" accessibilityLabel="Mais opções" onPress={noop} />
          <IconButton icon="x" accessibilityLabel="Fechar" onPress={noop} />
        </View>
      </Block>
    </>
  );
}

/** Componentes da Fase 2 (posts, comentários, Criar, perfil), com variantes e estados. */
export function Phase2Components() {
  return (
    <>
      <PostPhotoBlock />
      <PostTextBlock />
      <CommentsBlock />
      <CreateBlocks />
      <ProfileBlocks />
    </>
  );
}

function FeedChrome({ tab, children }: { tab: 'photo' | 'text'; children: ReactNode }) {
  return (
    <View style={styles.phone}>
      <View style={styles.feedHeader}>
        <Logo variant="lockup" size={24} />
        <IconButton icon="heart" accessibilityLabel="Notificações" onPress={noop} />
      </View>
      <TopTabs
        value={tab}
        onChange={noop}
        tabs={[
          { key: 'photo', label: 'Fotos', accessibilityLabel: 'Fotos' },
          { key: 'text', label: 'Textos', accessibilityLabel: 'Textos' },
          { key: 'reel', label: 'Reels', accessibilityLabel: 'Reels' },
        ]}
      />
      {children}
    </View>
  );
}

/** Telas compostas só com fixtures, para comparar com p06 e p07 (ux.md §6.15). */
export function ComposedScreens() {
  const width = useContentWidth();
  return (
    <>
      <Block title="Feed Fotos (p06)">
        <FeedChrome tab="photo">
          <PostPhoto
            testID="catalog-feed-photo"
            width={width}
            author={{ handle: 'marinac', name: 'Marina Costa' }}
            relation="connection"
            images={[azul, verde]}
            caption="Domingo de manhã no Passaúna. Ninguém por perto, só o barulho da água."
            likeCount={6}
            liked={false}
            commentCount={2}
            publishedAt={ago(18 * MIN)}
            now={NOW}
            onLike={noop}
            onOpenComments={noop}
          />
          <CaughtUp kind="photo" windowLabel={feedWindowLabel(72)} />
        </FeedChrome>
      </Block>
      <Block title="Feed Textos (p07)">
        <FeedChrome tab="text">
          {TEXTS.map((item) => (
            <PostText
              key={item.handle}
              author={{ handle: item.handle, name: item.name }}
              relation="connection"
              text={item.text}
              publishedAt={item.at}
              now={NOW}
              likeCount={item.likes}
              liked={false}
              commentCount={item.comments}
              onLike={noop}
              onComment={noop}
            />
          ))}
          <CaughtUp kind="text" windowLabel={feedWindowLabel(72)} />
        </FeedChrome>
      </Block>
    </>
  );
}

const styles = StyleSheet.create({
  block: { gap: theme.space[12] },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[8] },
  // Componentes de largura total: ocupam a área do catálogo sem a margem extra.
  bleed: { marginHorizontal: -theme.layout.screenX },
  sheet: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    borderTopLeftRadius: theme.radius.sheet,
    borderTopRightRadius: theme.radius.sheet,
    overflow: 'hidden',
  },
  pillStage: { paddingVertical: theme.space[16] },
  phone: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.white,
  },
  feedHeader: {
    height: theme.layout.headerHeight,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: theme.layout.screenX,
    paddingRight: theme.space[4],
  },
});
