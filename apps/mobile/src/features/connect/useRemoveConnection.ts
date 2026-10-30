import type { Me } from '@sussurro/shared';
import { useToast } from '@sussurro/ui';
import { useCallback } from 'react';
import { Alert } from 'react-native';

import { removeConnection } from './api';
import { isApiError } from '../../lib/api/errors';
import { messageForError } from '../../lib/error-messages';
import { useAuth } from '../auth/AuthProvider';
import { usePostStore } from '../posts/post-store';

/** Item do menu (lista de conexões e "Conectados" no perfil da conexão, ux.md §4.8 e §4.9). */
export const DISCONNECT_ACTION = 'Desfazer conexão';

/** O efeito, explicado antes de confirmar. A outra pessoa não é avisada (4.9 CA1). */
export const DISCONNECT_MESSAGE =
  'Vocês deixam de ver as publicações um do outro. A outra pessoa não é avisada.';

export function disconnectTitle(handle: string): string {
  return `Desfazer conexão com @${handle}?`;
}

export function disconnectedMessage(handle: string): string {
  return `Você desfez a conexão com @${handle}.`;
}

/** "conexões" do próprio perfil, na hora. */
function withConnections(user: Me, delta: number): Me {
  if (user.accountType !== 'personal') return user;
  return {
    ...user,
    counts: { ...user.counts, connections: Math.max(0, user.counts.connections + delta) },
  };
}

export interface RemoveConnectionCallbacks {
  /** Logo depois de confirmar (a linha some, ou sai do perfil). */
  onRemoved: () => void;
  /** A API recusou: a linha volta. */
  onFailed?: () => void;
}

/**
 * Desfazer conexão (4.9, D8) com Alert de confirmação. Otimista: a linha some e o número de
 * conexões cai na hora; as publicações da pessoa somem das listas já carregadas. Se a API falhar,
 * tudo volta com o Toast. Um 404 quer dizer que a conexão já não existia (fica desfeita).
 */
export function useRemoveConnection() {
  const { api, patchUser, reloadUser } = useAuth();
  const posts = usePostStore();
  const toast = useToast();

  return useCallback(
    (handle: string, callbacks: RemoveConnectionCallbacks) => {
      Alert.alert(disconnectTitle(handle), DISCONNECT_MESSAGE, [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Desfazer',
          style: 'destructive',
          onPress: () => {
            callbacks.onRemoved();
            patchUser((user) => withConnections(user, -1));
            posts.hidePostsOf(handle);
            removeConnection(api, handle)
              .then(() => {
                toast.show({ message: disconnectedMessage(handle), variant: 'success' });
                reloadUser().catch(() => undefined);
              })
              .catch((error: unknown) => {
                if (isApiError(error, 'NOT_FOUND')) {
                  reloadUser().catch(() => undefined);
                  return;
                }
                patchUser((user) => withConnections(user, 1));
                posts.showPostsOf(handle);
                callbacks.onFailed?.();
                toast.show({ message: messageForError(error), variant: 'error' });
              });
          },
        },
      ]);
    },
    [api, patchUser, posts, reloadUser, toast],
  );
}
