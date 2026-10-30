import { MONTHS_SHORT } from '@sussurro/ui';

/**
 * Textos da tela Conectar, como no protótipo (p10–p14, p22) e no ux.md (§4.10 a §4.12, §5.2 e §7.3).
 * Onde os documentos não dão texto, a decisão está marcada com "(4b)" e registrada no README.
 */

/** Primeiro nome para "Aguardando Caio confirmar" (o @ completo aparece na folha). */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** "27 out 2026" (p14: sempre com o ano). */
export function formatConnectedDate(at: number): string {
  const date = new Date(at);
  return `${date.getDate()} ${MONTHS_SHORT[date.getMonth()] ?? ''} ${date.getFullYear()}`;
}

/** "1:45" (ux.md §4.11). */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
}

export const COPY = {
  title: 'Conectar',
  intro:
    'Conexões só acontecem ao vivo, com os celulares próximos. As duas pessoas precisam confirmar.',
  modeGroup: 'Como conectar',
  modeBluetooth: 'Bluetooth',
  modeQr: 'QR code',
  search: 'Procurar por perto',
  searchHint: 'Fiquem a poucos metros, os dois com esta tela aberta.',
  simulate: 'Simular um pedido recebido',
  searching: 'Procurando por perto…',
  keepOpen: 'Mantenha o app aberto',
  cancel: 'Cancelar',
  nobodyTitle: 'Ninguém por perto ainda',
  nobodyText: 'Peça para a outra pessoa abrir a tela Conectar. Se não aparecer, usem o QR code.',
  useQr: 'Usar QR code',
  nearbyTitle: 'Por perto agora',
  nearbyFooter:
    'Via Bluetooth. Só aparece quem está com a tela Conectar aberta agora. Ninguém vê sua localização.',
  searchAgain: 'Procurar de novo',
  connect: 'Conectar',
  connectedLabel: 'Conectados',
  waitingTitle: (first: string) => `Aguardando ${first} confirmar`,
  waitingText: (first: string) =>
    `O pedido apareceu no celular de ${first}. A conexão só existe quando as duas pessoas confirmam.`,
  waitingQr: (first: string) => `${first} precisa ler este código para confirmar`,
  cancelRequest: 'Cancelar pedido',
  notConfirmedTitle: (first: string) => `${first} não confirmou`,
  notConfirmedText: 'O pedido vale por 2 minutos. Vocês podem tentar de novo.',
  tryAgain: 'Tentar de novo',
  back: 'Voltar',
  connectedTitle: (first: string) => `Você e ${first} estão conectados`,
  connectedSince: (date: string) => `Conectados pessoalmente em ${date}.`,
  connectedText: 'Agora vocês veem as publicações um do outro, em ordem cronológica.',
  goHome: 'Ir para o início',
  connectAnother: 'Conectar outra pessoa',
  // Toasts do §5.2.
  alreadyConnected: 'Vocês já estão conectados.',
  cannotSend: 'Não foi possível enviar o pedido agora. Tente mais tarde.',
  left: (first: string) => `${first} saiu de perto. Procure de novo.`,
  // Estados de erro do §5.2.
  pausedTitle: 'Muitas tentativas',
  pausedText: 'Você poderá procurar de novo em alguns minutos.',
  unavailableTitle: 'Conectar está indisponível agora',
  unavailableText: 'Tente de novo em instantes.',
  offlineTitle: 'Sem internet',
  offlineText: 'Conectar precisa de internet para confirmar quem é quem.',
  // (4b) E-mail não confirmado: o servidor recusa os tokens (X.3).
  emailTitle: 'Confirme seu e-mail para se conectar',
  emailText: 'Conectar fica disponível depois que você confirma o e-mail da sua conta.',
  verifyEmail: 'Verificar e-mail',
  // Permissões (§4.12).
  btExplainTitle: 'Permitir o Bluetooth',
  btExplainText:
    'O Sussurro usa o Bluetooth para achar quem está com esta tela aberta perto de você. Ninguém vê sua localização, e nada é transmitido com o app fechado.',
  continue: 'Continuar',
  btDeniedTitle: 'Bluetooth sem permissão',
  btDeniedText: 'Para achar pessoas por perto, permita o Bluetooth nos Ajustes.',
  openSettings: 'Abrir Ajustes',
  btOffTitle: 'O Bluetooth está desligado',
  btOffText: 'Ligue o Bluetooth para procurar quem está por perto.',
  turnOnBluetooth: 'Ligar Bluetooth',
  cannotAdvertiseTitle: 'Seu celular não consegue ser encontrado',
  cannotAdvertiseText:
    'Você ainda acha outras pessoas, mas elas não acham você. Use o QR code para garantir.',
  searchAnyway: 'Procurar mesmo assim',
  // (4b) Sem Bluetooth (aparelho sem BLE ou build sem o módulo nativo).
  btUnavailableTitle: 'Bluetooth indisponível neste celular',
  btUnavailableText: 'Use o QR code para se conectar com quem está com você.',
  // QR (§4.10).
  qrHint: 'Peça para a outra pessoa ler este código.',
  readTheirCode: 'Ler o código dela',
  scannerTitle: 'Ler código',
  scannerHint: 'Aponte a câmera para o código da outra pessoa.',
  close: 'Fechar',
  cameraExplainTitle: 'Ler o código da outra pessoa',
  cameraExplainText: 'A câmera é usada só para ler o QR code.',
  cameraDeniedTitle: 'Câmera sem permissão',
  cameraDeniedText: 'Permita a câmera nos Ajustes ou peça para a outra pessoa ler o seu código.',
  showMyCode: 'Mostrar meu código',
  // (4b) QR vencido ou adulterado (4.7 CA4): nada é criado.
  qrInvalid:
    'Este código venceu ou não é do Sussurro. Peça para a outra pessoa mostrar o código de novo.',
  // (4b) No aceite por QR, o código lido é de outra pessoa.
  qrNotTheirs: (first: string) =>
    `Este código não é de ${first}. Leia o código que aparece no celular de ${first}.`,
  // Folha do pedido recebido (§4.11). Sem artigo antes do nome ("a Helena"): o app não sabe o gênero.
  sheetTitle: (first: string) => `${first} quer se conectar`,
  sheetConfirm: (first: string) => `Confirme só se ${first} estiver aí com você.`,
  accept: 'Aceitar',
  acceptByQr: 'Ler código para aceitar',
  decline: 'Recusar',
  expiresIn: (countdown: string) => `Expira em ${countdown}`,
  expired: (first: string) => `O pedido de ${first} expirou.`,
  // (4b) O pedido sumiu antes de vencer (cancelado por quem pediu).
  gone: (first: string) => `O pedido de ${first} não está mais disponível.`,
  // (4b) Aceite por Bluetooth sem ter visto o anúncio de quem pediu.
  notSeen: (first: string) =>
    `O Sussurro ainda não encontrou ${first} por perto. Aproximem os celulares e tentem de novo.`,
  // (4b) Aceite recusado pelo token (o pedido continua valendo).
  acceptFailed: 'Não foi possível confirmar agora. Aproximem os celulares e tentem de novo.',
  // Leitor de tela (§7.3).
  announceFound: (name: string) => `${name} encontrado por perto`,
  announceSent: 'Pedido enviado',
  announceConnected: 'Vocês estão conectados',
  announceNotConfirmed: 'Pedido recusado ou expirado',
  // Criador (p22).
  creatorTitle: 'Indisponível para criadores',
  creatorText: 'Contas de criador só publicam. Elas não se conectam nem seguem outras contas.',
  backToProfile: 'Voltar ao perfil',
} as const;
