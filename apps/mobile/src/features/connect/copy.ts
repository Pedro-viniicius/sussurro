import { MONTHS_SHORT } from '@sussurro/ui';

/**
 * Textos da tela Conectar: os do protótipo (p10–p14, p22), os do ux.md (§4.10 a §4.12, §5.2 e §7.3)
 * e, para o "encostar" (ADR 0012), os T1 a T42 e os anúncios A1 a A6 do ux.md §11.8 e §11.9,
 * aprovados pelo PO em 2026-10-30 como estão. Onde os documentos não dão texto, a decisão está
 * marcada com "(4b)" e registrada no README.
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
  // T1
  intro:
    'Conexões só acontecem ao vivo, com os celulares encostados. As duas pessoas precisam confirmar.',
  // T2, T3
  modeGroup: 'Como conectar',
  modeTouch: 'Encostar',
  modeQr: 'QR code',
  // Pronto (estado 6): T4, T5 e a nota T43 (no lugar do T6; aprovado pelo PO em 2026-10-30).
  readyTitle: 'Encoste o seu celular no da outra pessoa',
  readyText:
    'Os dois com esta tela aberta. Juntem as partes de cima dos celulares e segurem por um instante.',
  privacyNote:
    'Seu nome e sua foto só aparecem quando os dois celulares percebem o encosto, e você vê a outra pessoa na mesma hora.',
  // Aproximando (7): T7, T8.
  approachingTitle: 'Quase lá',
  approachingText: 'Encostem os celulares e segurem por um instante.',
  // Confirmando (8): T9, T10.
  confirmingTitle: 'Encostou!',
  confirmingText: 'Segurem mais um instante…',
  // Não deu para confirmar (9): T11.
  touchFailed: 'Não deu para confirmar. Afastem e encostem os celulares de novo.',
  // Nada detectado (10): T12, T13, T14.
  nobodyTitle: 'Não está dando certo?',
  nobodyText:
    'Confiram se a outra pessoa está com a tela Conectar aberta e encostem as partes de cima dos celulares. Se não funcionar, usem o QR code.',
  useQr: 'Usar QR code',
  // Cartão de quem encostou (11, 12): T15 a T18.
  cardCheck: 'Confira se é a pessoa que está com você.',
  connectWith: (first: string) => `Conectar com ${first}`,
  connectWithLabel: (name: string, handle: string) => `Conectar com ${name}, @${handle}`,
  cancel: 'Cancelar',
  alreadyConnected: 'Vocês já estão conectados.',
  // T46 (aprovado pelo PO em 2026-10-30): o prazo da denúncia, só no formulário aberto pelo cartão
  // (11, 14 e Bloqueado), nunca no 12 nem na rota `/denunciar` (ux.md §11.14).
  reportDeadline: 'Envie em até 1 minuto depois do encosto.',
  // Cartão venceu (17): T20, no Toast e no leitor de tela.
  cardExpired: (first: string) =>
    `O tempo para conectar com ${first} acabou. Encostem os celulares de novo.`,
  // (dev, D15) Simulações e a calibração: só no build de desenvolvimento.
  simulate: 'Simular um pedido recebido',
  simulateTouch: 'Simular o outro celular encostando',
  calibration: 'Calibração do encostar (dev)',
  waitingTitle: (first: string) => `Aguardando ${first} confirmar`,
  waitingText: (first: string) =>
    `O pedido apareceu no celular de ${first}. A conexão só existe quando as duas pessoas confirmam.`,
  waitingQr: (first: string) => `${first} precisa ler este código para confirmar`,
  cancelRequest: 'Cancelar pedido',
  notConfirmedTitle: (first: string) => `${first} não confirmou`,
  // T21: pelo encostar e pelo QR.
  notConfirmedText: (method: 'ble' | 'qr') =>
    method === 'ble'
      ? 'O pedido vale por 2 minutos. Para tentar de novo, encostem os celulares outra vez.'
      : 'O pedido vale por 2 minutos. Vocês podem tentar de novo.',
  tryAgain: 'Tentar de novo',
  back: 'Voltar',
  connectedTitle: (first: string) => `Você e ${first} estão conectados`,
  connectedSince: (date: string) => `Conectados pessoalmente em ${date}.`,
  connectedText: 'Agora vocês veem as publicações um do outro, em ordem cronológica.',
  goHome: 'Ir para o início',
  connectAnother: 'Conectar outra pessoa',
  // Toasts do §5.2.
  cannotSend: 'Não foi possível enviar o pedido agora. Tente mais tarde.',
  // Estados de erro do §5.2 (T22 no "Muitas tentativas").
  pausedTitle: 'Muitas tentativas',
  pausedText: 'Você poderá tentar de novo em alguns minutos.',
  unavailableTitle: 'Conectar está indisponível agora',
  unavailableText: 'Tente de novo em instantes.',
  offlineTitle: 'Sem internet',
  offlineText: 'Conectar precisa de internet para confirmar quem é quem.',
  // (4b) E-mail não confirmado: o servidor recusa os tokens (X.3).
  emailTitle: 'Confirme seu e-mail para se conectar',
  emailText: 'Conectar fica disponível depois que você confirma o e-mail da sua conta.',
  verifyEmail: 'Verificar e-mail',
  // Permissões (§4.12 e §11.9): T23 a T29. O texto da explicação é o T44 (no lugar do T23;
  // aprovado pelo PO em 2026-10-30).
  btExplainTitle: 'Permitir o Bluetooth',
  btExplainText:
    'O Sussurro usa o Bluetooth só para perceber quando o seu celular encosta no de outra pessoa. Seu nome e sua foto não passam pelo Bluetooth, e nada é transmitido com o app fechado.',
  btExplainLegacy:
    'Neste celular, o sistema chama essa permissão de localização. O Sussurro não usa nem guarda onde você está.',
  continue: 'Continuar',
  btDeniedTitle: 'Bluetooth sem permissão',
  btDeniedText: 'Para encostar os celulares, permita o Bluetooth nos Ajustes.',
  openSettings: 'Abrir Ajustes',
  btOffTitle: 'O Bluetooth está desligado',
  btOffText: 'Ligue o Bluetooth para encostar os celulares.',
  turnOnBluetooth: 'Ligar Bluetooth',
  locationOffTitle: 'Ligue a localização do celular',
  locationOffText:
    'Neste celular, o Android só deixa encostar com a localização ligada. O Sussurro não usa nem guarda onde você está.',
  btUnavailableTitle: 'Este celular não consegue encostar',
  btUnavailableText: 'Use o QR code para se conectar com quem está com você.',
  // T30: a faixa do QR quando o celular não consegue encostar.
  unsupportedBanner: 'Este celular não consegue encostar. Use o QR code.',
  // QR (§4.10 e §11.6): T32 a T34.
  qrExplain:
    'Use quando encostar não funcionar: um celular mostra o código e o outro lê com a câmera.',
  qrHint: 'Peça para a outra pessoa ler este código. Mostre só para quem está com você.',
  readTheirCode: 'Ler o código da outra pessoa',
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
  // Folha do pedido recebido (§4.11) e o pedido no cartão (T37). Sem artigo antes do nome ("a
  // Helena"): o app não sabe o gênero.
  sheetTitle: (first: string) => `${first} quer se conectar`,
  sheetConfirm: (first: string) => `Confirme só se ${first} estiver aí com você.`,
  accept: 'Aceitar',
  acceptByQr: 'Ler código para aceitar',
  decline: 'Recusar',
  expiresIn: (countdown: string) => `Expira em ${countdown}`,
  expired: (first: string) => `O pedido de ${first} expirou.`,
  // (4b) O pedido sumiu antes de vencer (cancelado por quem pediu).
  gone: (first: string) => `O pedido de ${first} não está mais disponível.`,
  // T35: o aceite por encostar recusado pelo servidor (o pedido continua valendo).
  notSeen: (first: string) => `Encoste o seu celular no de ${first} e toque em Aceitar de novo.`,
  // T45 (no lugar do T36; aprovado pelo PO em 2026-10-30): o aceite por QR recusado pelo código
  // lido (o pedido continua valendo). Só o aceite por QR mostra este texto.
  acceptFailed: (first: string) =>
    `Não foi possível confirmar agora. Leia o código de ${first} de novo.`,
  // Leitor de tela: A1 a A6 (§11.8) e os mantidos do §7.3.
  announceApproaching: 'Quase lá. Encostem os celulares.',
  announceConfirming: 'Encostou. Segurem mais um instante.',
  announceTouched: (name: string) =>
    `Encostou em ${name}. Confira se é a pessoa que está com você.`,
  announceTouchedConnected: (name: string) => `Encostou em ${name}. Vocês já estão conectados.`,
  announceIncoming: (first: string) => `${first} quer se conectar com você.`,
  announceNoTouch: 'Não está dando certo? Você pode usar o QR code.',
  announceSent: 'Pedido enviado',
  announceConnected: 'Vocês estão conectados',
  announceNotConfirmed: 'Pedido recusado ou expirado',
  // T41 (opcional, só no iPhone): o uso depende do resultado do spike 4.1-B (ux.md §11.7 e §11.12).
  nameDropNote:
    'Se o iPhone abrir a troca de contatos, não precisa usar: o Sussurro conecta sem ela.',
  // Criador (p22).
  creatorTitle: 'Indisponível para criadores',
  creatorText: 'Contas de criador só publicam. Elas não se conectam nem seguem outras contas.',
  backToProfile: 'Voltar ao perfil',
} as const;
