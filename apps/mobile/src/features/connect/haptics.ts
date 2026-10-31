import * as Haptics from 'expo-haptics';

/**
 * Os três momentos com vibração na tela Conectar (ux.md §11.7 e §11.8, D-UX24):
 * - `touched`: o cartão de quem encostou aparece, o "pode afastar" (impacto médio, 1 vez);
 * - `incoming`: um pedido recebido (o cartão vira o pedido ou a folha abre), impacto leve;
 * - `connected`: "Vocês estão conectados" (sucesso).
 *
 * **Nunca no "Confirmando"**: ali a pessoa ainda precisa segurar os celulares juntos (e, entre
 * iPhones, o NameDrop pode estar aberto). A vibração nunca é o único aviso: cada momento tem texto
 * na tela e anúncio no leitor de tela. No iOS, o `expo-haptics` segue o "Feedback tátil do sistema".
 */
export type HapticMoment = 'touched' | 'incoming' | 'connected';

export function vibrate(moment: HapticMoment): void {
  let feedback: Promise<void>;
  switch (moment) {
    case 'touched':
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
