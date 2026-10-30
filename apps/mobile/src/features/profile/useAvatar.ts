import { MAX_IMAGE_BYTES } from '@sussurro/shared';
import { useToast } from '@sussurro/ui';
import { useCallback, useState } from 'react';
import { Alert } from 'react-native';

import { NetworkError } from '../../lib/api/errors';
import { messageForError, OFFLINE_MESSAGE } from '../../lib/error-messages';
import { useMedia } from '../../lib/media/MediaProvider';
import { sleep, timing } from '../../lib/timing';
import { useAuth } from '../auth/AuthProvider';
import { removeAvatar, requestAvatarUpload, setAvatar } from '../posts/api';

export const AVATAR_UPDATED_MESSAGE = 'Foto atualizada.';
export const AVATAR_REMOVED_MESSAGE = 'Foto removida.';
export const AVATAR_FAILED_MESSAGE = 'Não foi possível usar esta foto. Tente outra.';
export const AVATAR_PENDING_MESSAGE =
  'Sua foto ainda está sendo processada. Ela aparece em instantes.';
export const REMOVE_AVATAR_TITLE = 'Remover foto?';

/** Consultas ao `PUT /me/avatar` enquanto a foto está em `processing` (~1 min no total). */
const MAX_POLLS = 20;

/**
 * Foto de perfil (história 2.4): escolher no seletor (recorte quadrado), reduzir para JPEG, pedir a
 * URL, enviar ao S3 e repetir `PUT /me/avatar` até sair de `processing`. Remover volta às iniciais
 * sobre o pastel. Liberado mesmo sem e-mail confirmado (X.3).
 */
export function useAvatar() {
  const { api, reloadUser } = useAuth();
  const media = useMedia();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const fail = useCallback(
    (error: unknown) => {
      toast.show({
        message: error instanceof NetworkError ? OFFLINE_MESSAGE : messageForError(error),
        variant: 'error',
      });
    },
    [toast],
  );

  const change = useCallback(async () => {
    let picked;
    try {
      [picked] = await media.pickImages({ limit: 1, square: true });
    } catch (error) {
      fail(error);
      return;
    }
    if (picked === undefined) return;
    setBusy(true);
    try {
      const file = await media.prepareImage(picked);
      if (file.sizeBytes > MAX_IMAGE_BYTES) {
        toast.show({ message: AVATAR_FAILED_MESSAGE, variant: 'error' });
        return;
      }
      const target = await requestAvatarUpload(api, { mime: file.mime, sizeBytes: file.sizeBytes });
      await media.uploadFile(target, file);
      let result = await setAvatar(api, target.uploadId);
      let delay = timing.pollIntervalMs;
      for (let poll = 0; result.status === 'processing' && poll < MAX_POLLS; poll++) {
        await sleep(delay);
        delay = Math.min(delay * 1.5, 5_000);
        result = await setAvatar(api, target.uploadId);
      }
      if (result.status === 'ready') {
        await reloadUser();
        toast.show({ message: AVATAR_UPDATED_MESSAGE, variant: 'success' });
      } else if (result.status === 'processing') {
        toast.show({ message: AVATAR_PENDING_MESSAGE });
      } else {
        toast.show({ message: AVATAR_FAILED_MESSAGE, variant: 'error' });
      }
    } catch (error) {
      fail(error);
    } finally {
      setBusy(false);
    }
  }, [api, fail, media, reloadUser, toast]);

  const remove = useCallback(() => {
    Alert.alert(REMOVE_AVATAR_TITLE, undefined, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Remover',
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          removeAvatar(api)
            .then(() => reloadUser())
            .then(() => {
              toast.show({ message: AVATAR_REMOVED_MESSAGE, variant: 'success' });
            })
            .catch(fail)
            .finally(() => {
              setBusy(false);
            });
        },
      },
    ]);
  }, [api, fail, reloadUser, toast]);

  return { busy, change, remove };
}
