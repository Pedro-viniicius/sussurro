import { useToast } from '@sussurro/ui';
import { useCallback } from 'react';
import { Alert, type AlertButton } from 'react-native';

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

/** O que quem chama precisa saber do bloqueio além do 204 (o cartão do Conectar, ux.md §11.14). */
export interface BlockOptions {
  /** Depois do 204 (ex.: sair do perfil). */
  onBlocked?: () => void;
  /**
   * `false`: o 204 não mostra o Toast `blockedMessage`, porque quem chama já diz o que aconteceu
   * (o cartão "Bloqueado", M4) ou mostra o próprio aviso (M5).
   */
  successToast?: boolean;
  /** "Cancelar" no `Alert` (ou o `Alert` fechado sem escolha): o cartão volta a poder vencer (M2). */
  onCancel?: () => void;
  /**
   * "Bloquear" no `Alert`, antes da chamada. Devolver `false` desiste sem chamar a API: fora do par,
   * o 204 não grava, e o app diria "Você bloqueou" sem ter bloqueado (M7).
   */
  onConfirm?: () => boolean;
  /** A chamada falhou; o Toast do erro sai do mesmo jeito (M6). */
  onFailed?: () => void;
}

/**
 * Bloquear (X.2) com confirmação. Depois do 204, tudo o que é da conta some das listas já
 * carregadas (feed, perfis, comentários, busca e listas), o follow sai do store e o `GET /me` acerta
 * os números (a conexão e os follows foram desfeitos). O 2º argumento é o `onBlocked` (para sair do
 * perfil) ou as opções do cartão do Conectar (`BlockOptions`).
 */
export function useBlockAccount() {
  const { api, reloadUser } = useAuth();
  const posts = usePostStore();
  const follows = useFollowStore();
  const toast = useToast();

  return useCallback(
    (target: BlockTarget, options: BlockOptions | (() => void) = {}) => {
      const {
        onBlocked,
        successToast = true,
        onCancel,
        onConfirm,
        onFailed,
      } = typeof options === 'function' ? { onBlocked: options } : options;
      const buttons: AlertButton[] = [
        {
          text: 'Cancelar',
          style: 'cancel',
          ...(onCancel === undefined ? {} : { onPress: onCancel }),
        },
        {
          text: 'Bloquear',
          style: 'destructive',
          onPress: () => {
            if (onConfirm !== undefined && !onConfirm()) return;
            const body =
              target.commentId === undefined
                ? { handle: target.handle }
                : { commentId: target.commentId };
            blockAccount(api, body)
              .then(() => {
                posts.hideAuthor(target.handle);
                follows.set(target.handle, false);
                if (successToast) {
                  toast.show({ message: blockedMessage(target.handle), variant: 'success' });
                }
                onBlocked?.();
                void reloadUser().catch(() => undefined);
              })
              .catch((error: unknown) => {
                toast.show({ message: messageForError(error), variant: 'error' });
                onFailed?.();
              });
          },
        },
      ];
      if (onCancel === undefined) {
        Alert.alert(blockTitle(target.handle), BLOCK_MESSAGE, buttons);
      } else {
        // O `Alert` fechado sem escolha (Android, fora dele) também libera o cartão (M2, M15).
        Alert.alert(blockTitle(target.handle), BLOCK_MESSAGE, buttons, { onDismiss: onCancel });
      }
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
