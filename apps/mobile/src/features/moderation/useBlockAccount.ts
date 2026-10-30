import { useToast } from '@sussurro/ui';
import { useCallback } from 'react';
import { Alert } from 'react-native';

import { messageForError } from '../../lib/error-messages';
import { useAuth } from '../auth/AuthProvider';
import { usePostStore } from '../posts/post-store';
import { blockAccount, unblockAccount } from '../relations/api';
import { useFollowStore } from '../relations/follow-store';

/** Efeito do bloqueio, explicado antes de confirmar (X.2 CA1 e CA3). */
export const BLOCK_MESSAGE =
  'Vocês deixam de ver o perfil, as publicações e os comentários um do outro. A conexão e os follows entre vocês são desfeitos, e os comentários de um nas publicações do outro são apagados.';

/** Desbloquear não desfaz o que o bloqueio desfez. */
export const UNBLOCK_MESSAGE =
  'Vocês voltam a se ver, mas a conexão e os follows desfeitos no bloqueio não voltam sozinhos.';

export function blockTitle(handle: string): string {
  return `Bloquear @${handle}?`;
}

export function unblockTitle(handle: string): string {
  return `Desbloquear @${handle}?`;
}

export function blockedMessage(handle: string): string {
  return `Você bloqueou @${handle}.`;
}

export function unblockedMessage(handle: string): string {
  return `Você desbloqueou @${handle}.`;
}

/** Quem bloquear: pelo @ (post, perfil) ou pelo comentário (o @ pode não ter perfil visível). */
export interface BlockTarget {
  handle: string;
  commentId?: string;
}

/**
 * Bloquear (X.2) com confirmação. Depois do 204, tudo o que é da conta some das listas já
 * carregadas (feed, perfis, comentários, busca e listas), o follow sai do store e o `GET /me` acerta
 * os números (a conexão e os follows foram desfeitos). `onBlocked` serve para sair do perfil.
 */
export function useBlockAccount() {
  const { api, reloadUser } = useAuth();
  const posts = usePostStore();
  const follows = useFollowStore();
  const toast = useToast();

  return useCallback(
    (target: BlockTarget, onBlocked?: () => void) => {
      Alert.alert(blockTitle(target.handle), BLOCK_MESSAGE, [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Bloquear',
          style: 'destructive',
          onPress: () => {
            const body =
              target.commentId === undefined
                ? { handle: target.handle }
                : { commentId: target.commentId };
            blockAccount(api, body)
              .then(() => {
                posts.hideAuthor(target.handle);
                follows.set(target.handle, false);
                toast.show({ message: blockedMessage(target.handle), variant: 'success' });
                onBlocked?.();
                void reloadUser().catch(() => undefined);
              })
              .catch((error: unknown) => {
                toast.show({ message: messageForError(error), variant: 'error' });
              });
          },
        },
      ]);
    },
    [api, follows, posts, reloadUser, toast],
  );
}

/** Desbloquear (X.2) com confirmação; `onUnblocked` tira a linha da lista. */
export function useUnblockAccount() {
  const { api } = useAuth();
  const posts = usePostStore();
  const toast = useToast();

  return useCallback(
    (handle: string, onUnblocked: () => void) => {
      Alert.alert(unblockTitle(handle), UNBLOCK_MESSAGE, [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Desbloquear',
          onPress: () => {
            unblockAccount(api, handle)
              .then(() => {
                posts.showAuthor(handle);
                onUnblocked();
                toast.show({ message: unblockedMessage(handle), variant: 'success' });
              })
              .catch((error: unknown) => {
                toast.show({ message: messageForError(error), variant: 'error' });
              });
          },
        },
      ]);
    },
    [api, posts, toast],
  );
}
