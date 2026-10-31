import { type UseActionSheet, useActionSheet } from '@sussurro/ui';
import { router } from 'expo-router';
import { useCallback } from 'react';

import { reportHref } from './report-target';
import { useBlockAccount } from './useBlockAccount';

/** Alvo do menu ⋯ de uma publicação ou de um perfil de outra conta. */
export type ModerationTarget =
  { type: 'post'; id: string; handle: string } | { type: 'account'; handle: string };

export const REPORT_ACTION = 'Denunciar';
export const BLOCK_ACTION = 'Bloquear';

/**
 * Menu ⋯ de publicações e perfis de outras contas (D-UX14): "Denunciar" vem antes de "Bloquear",
 * porque depois do bloqueio as publicações da conta viram 404 e o perfil fecha, e este menu não
 * volta a aparecer para ela. O servidor ainda aceita denunciar a conta que você bloqueou
 * (R1-PO-1), mas o app só oferece isso no Bloqueado do Conectar (ux.md §11.14). O `element`
 * precisa estar na árvore da tela.
 */
export function useModerationMenu(): {
  open: (target: ModerationTarget, onBlocked?: () => void) => void;
  element: UseActionSheet['element'];
} {
  const { show, element } = useActionSheet('moderation-menu');
  const block = useBlockAccount();

  const open = useCallback(
    (target: ModerationTarget, onBlocked?: () => void) => {
      show({
        title:
          target.type === 'post'
            ? `Publicação de @${target.handle}`
            : `Perfil de @${target.handle}`,
        actions: [
          {
            label: REPORT_ACTION,
            onPress: () => {
              router.push(
                reportHref(
                  target.type === 'post'
                    ? { type: 'post', id: target.id }
                    : { type: 'account', handle: target.handle },
                ),
              );
            },
          },
          {
            label: BLOCK_ACTION,
            destructive: true,
            onPress: () => {
              block({ handle: target.handle }, onBlocked);
            },
          },
        ],
      });
    },
    [block, show],
  );

  return { open, element };
}
