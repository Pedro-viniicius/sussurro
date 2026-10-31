import { formatReelDuration, type Post, type PostMedia } from '@sussurro/shared';
import { ReelTile, type ReelTileStatus, spokenDuration, useActionSheet } from '@sussurro/ui';
import { router } from 'expo-router';

import { usePublishing } from '../create/PublishingProvider';
import type { TabBase } from '../navigation/routes';
import { reelHref } from '../posts/navigation';
import { usePost } from '../posts/post-store';
import { useDeletePost } from '../posts/useDeletePost';

export const FAILED_REEL_TITLE = 'Não foi possível publicar este reel.';
export const RETRY_ACTION = 'Tentar de novo';
export const DELETE_ACTION = 'Excluir';

/** O vídeo do reel (posição 0). */
export function videoOf(post: Post): PostMedia | undefined {
  return post.media.find((item) => item.kind === 'video') ?? post.media[0];
}

/** Estado do tile: pronto só com o post publicado e o vídeo pronto (URLs só com `ready`). */
export function reelTileStatus(post: Post): ReelTileStatus {
  if (post.status === 'failed') return 'failed';
  return post.status === 'published' && videoOf(post)?.status === 'ready' ? 'ready' : 'processing';
}

/** "Reel de @marinac, 42 segundos" (ux.md §6.14). */
export function reelLabel(post: Post): string {
  const durationS = videoOf(post)?.durationS ?? null;
  const base = `Reel de @${post.author.handle}`;
  return durationS === null ? base : `${base}, ${spokenDuration(durationS)}`;
}

export interface ReelGridTileProps {
  postId: string;
  width: number;
  /** Aba de origem: o visualizador abre os perfis dentro dela. */
  base: TabBase;
}

/**
 * Tile da grade de reels (feed e perfil, p08): abre o visualizador. No próprio perfil, o reel em
 * processamento mostra "Processando" e o que falhou, "Falhou" com "Tentar de novo" (recria com o
 * mesmo vídeo, 5.6) e "Excluir". Quem lista os ids já tirou o que não é publicado de outra conta.
 */
export function ReelGridTile({ postId, width, base }: ReelGridTileProps) {
  const post = usePost(postId);
  const publishing = usePublishing();
  const confirmDelete = useDeletePost();
  const actions = useActionSheet('reel-falhou-menu');
  if (post === undefined) return null;

  const video = videoOf(post);
  const status = reelTileStatus(post);
  const duration =
    video?.durationS === null || video?.durationS === undefined
      ? null
      : formatReelDuration(video.durationS);

  const onPress =
    status === 'ready'
      ? () => {
          router.push(reelHref(post.id, base));
        }
      : status === 'failed' && post.isOwn
        ? () => {
            actions.show({
              title: FAILED_REEL_TITLE,
              actions: [
                {
                  label: RETRY_ACTION,
                  onPress: () => {
                    publishing.retryFailedReel(post);
                  },
                },
                {
                  label: DELETE_ACTION,
                  destructive: true,
                  onPress: () => {
                    confirmDelete(post.id);
                  },
                },
              ],
            });
          }
        : undefined;

  return (
    <>
      <ReelTile
        thumb={{ key: video?.id ?? post.id, uri: video?.thumbUrl ?? null }}
        duration={duration}
        width={width}
        status={status}
        {...(onPress === undefined ? {} : { onPress })}
        accessibilityLabel={reelLabel(post)}
        testID={`reel-${post.id}`}
      />
      {actions.element}
    </>
  );
}
