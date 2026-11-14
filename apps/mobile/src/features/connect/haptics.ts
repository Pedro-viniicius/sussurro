import * as Haptics from 'expo-haptics';

/**
 * Os três momentos com vibração na tela Conectar (ux.md §11.7 e D-UX24, adaptados à ADR 0013):
 * - `read`: um código foi lido (NFC ou câmera), impacto médio, 1 vez;
 * - `incoming`: um pedido recebido (a folha abre), impacto leve;
 * - `connected`: "Vocês estão conectados" (sucesso).
 *
 * A vibração nunca é o único aviso: cada momento tem texto na tela e anúncio no leitor de tela. No
 * iOS, o `expo-haptics` segue o "Feedback tátil do sistema".
 */
export type HapticMoment = 'read' | 'incoming' | 'connected';

export function vibrate(moment: HapticMoment): void {
  let feedback: Promise<void>;
  switch (moment) {
    case 'read':
      feedback = Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      break;
    case 'incoming':
      feedback = Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      break;
    case 'connected':
      feedback = Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      break;
  }
  // Sem o módulo (web, build antigo) ou sem motor de vibração: segue sem vibrar.
  feedback.catch(() => undefined);
}
