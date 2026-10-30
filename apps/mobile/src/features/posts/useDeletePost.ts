import { useToast } from '@sussurro/ui';
import { useCallback } from 'react';
import { Alert } from 'react-native';

import { deletePost } from './api';
import { usePostStore } from './post-store';
import { isApiError } from '../../lib/api/errors';
import { messageForError } from '../../lib/error-messages';
import { useAuth } from '../auth/AuthProvider';

export const DELETE_POST_TITLE = 'Excluir publicação?';
export const POST_DELETED_MESSAGE = 'Publicação excluída.';

/**
 * Apagar a própria publicação (2.9) com confirmação. Some na hora do feed, do perfil e do detalhe
 * (o store marca como apagada) e o número de publicações é recarregado.
 */
export function useDeletePost() {
  const { api, reloadUser } = useAuth();
  const store = usePostStore();
  const toast = useToast();

  return useCallback(
    (postId: string, onDeleted?: () => void) => {
      Alert.alert(DELETE_POST_TITLE, 'Não dá para desfazer.', [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Excluir',
          style: 'destructive',
          onPress: () => {
            deletePost(api, postId)
              .catch((error: unknown) => {
                // Já apagada em outro aparelho: o resultado é o mesmo.
                if (!isApiError(error, 'NOT_FOUND')) throw error;
              })
              .then(() => {
                store.remove(postId);
                toast.show({ message: POST_DELETED_MESSAGE, variant: 'success' });
                onDeleted?.();
                void reloadUser().catch(() => undefined);
              })
              .catch((error: unknown) => {
                toast.show({ message: messageForError(error), variant: 'error' });
              });
          },
        },
      ]);
    },
    [api, reloadUser, store, toast],
  );
}
