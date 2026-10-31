import type { Post } from '@sussurro/shared';
import { PostPhoto, type PostRelation, PostText } from '@sussurro/ui';
import { router } from 'expo-router';

import { commentsHref, postHref, profileHref } from './navigation';
import { usePost } from './post-store';
import { useDeletePost } from './useDeletePost';
import { useLike } from './useLike';
import { useSignedInUser } from '../auth/AuthProvider';
import { useModerationMenu } from '../moderation/useModerationMenu';
import type { TabBase } from '../navigation/routes';

export function relationOf(post: Post): PostRelation {
  if (post.isOwn) return 'self';
  return post.author.accountType === 'creator' ? 'creator' : 'connection';
}

/** Fotos na ordem da publicação; a chave do cache é o id da mídia (as URLs mudam a cada resposta). */
export function imagesOf(post: Post) {
  return [...post.media]
    .sort((a, b) => a.position - b.position)
    .map((media) => ({ key: media.id, uri: media.url }));
}

export interface PostCardProps {
  postId: string;
  /** Aba de origem (`/pessoal/inicio`…): o detalhe e os perfis abrem dentro dela. */
  base: TabBase;
  /** No detalhe os comentários já estão abaixo do post e não há "abrir publicação". */
  inDetail?: boolean;
  /** Depois de apagar o post ou bloquear o autor (no detalhe, volta). */
  onDeleted?: () => void;
  now?: Date;
}

/**
 * Liga um post da API aos componentes do design system: curtir (só pessoa, A-06), comentários,
 * perfil do autor, detalhe e o menu ⋯: "Excluir publicação" nos próprios posts; "Denunciar" e
 * "Bloquear" nos de outras contas (D-UX14).
 */
export function PostCard({ postId, base, inDetail = false, onDeleted, now }: PostCardProps) {
  const post = usePost(postId);
  const user = useSignedInUser();
  const like = useLike();
  const confirmDelete = useDeletePost();
  const menu = useModerationMenu();
  if (post === undefined) return null;

  const author = {
    handle: post.author.handle,
    name: post.author.name,
    avatarUri: post.author.avatarUrl,
  };
  const common = {
    author,
    relation: relationOf(post),
    likeCount: post.likeCount,
    liked: post.likedByMe,
    commentCount: post.commentCount,
    publishedAt: post.publishedAt ?? post.createdAt,
    ...(now === undefined ? {} : { now }),
    // Criador não curte (A-06): o servidor responde 403, então o app nem oferece.
    canLike: user.accountType === 'personal',
    onLike: () => {
      void like(post.id);
    },
    onOpenAuthor: () => {
      router.push(profileHref(base, post.author.handle, user));
    },
    onMore: post.isOwn
      ? () => {
          confirmDelete(post.id, onDeleted);
        }
      : () => {
          menu.open({ type: 'post', id: post.id, handle: post.author.handle }, onDeleted);
        },
    testID: `post-${post.id}`,
  };
  const openComments = () => {
    router.push(commentsHref(post.id, base));
  };

  if (post.type === 'text') {
    return (
      <>
        <PostText
          {...common}
          text={post.text ?? ''}
          {...(inDetail
            ? {}
            : {
                onComment: openComments,
                onOpen: () => {
                  router.push(postHref(base, post.id));
                },
              })}
        />
        {menu.element}
      </>
    );
  }
  return (
    <>
      <PostPhoto
        {...common}
        images={imagesOf(post)}
        caption={post.caption}
        {...(inDetail ? {} : { onOpenComments: openComments })}
      />
      {menu.element}
    </>
  );
}
