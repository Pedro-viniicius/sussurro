import { MONTHS_SHORT } from '@sussurro/ui';

/**
 * Textos da tela Conectar: os do protótipo (p10–p14, p22), os do ux.md (§4.10 a §4.12, §5.2 e §7.3)
 * e os da ADR 0013 §5 (NFC e QR code, sem Bluetooth), revisados pelo `ux-ui` (ux.md §11.19) e
 * aprovados pelo PO em 2026-11-14. Onde os documentos não dão texto, a decisão está marcada com
 * "(4b)" e registrada no README.
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
  // N1, no lugar do T1: o gesto não é mais só encostar.
  intro:
    'Conexões só acontecem ao vivo, com as duas pessoas juntas. Uma lê o código da outra, e as duas confirmam.',
  // Seletor (ADR 0013 §5).
  modeGroup: 'Como conectar',
  modeShow: 'Mostrar meu código',
  modeRead: 'Ler código',
  // Mostrar meu código (QR, §4.10, e o NFC da ADR 0013).
  qrHint: 'Peça para a outra pessoa ler este código. Mostre só para quem está com você.',
  // S5 (ux.md §11.20, aprovado pelo PO em 2026-11-20): o rótulo do QR para o leitor de tela
  // enquanto ele carrega (a espera pela vaga e o "Tentar de novo" depois da parada, C4).
  qrLoading: 'Carregando o seu código',
  // N6: com o NFC ligado, este celular também entrega o código por NFC. Diz o que o outro faz.
  emitHint: 'Ou a outra pessoa toca em Ler código e encosta o celular nas costas deste.',
  // N7: no "Aguardando", quem lê é quem recebeu o pedido, pela folha (toca em Aceitar).
  waitingEmitHint: (first: string) =>
    `Ou ${first} toca em Aceitar e encosta o celular nas costas deste.`,
  // NFC desligado (Android).
  nfcOffTitle: 'O NFC está desligado',
  nfcOffText: 'Ligue o NFC para trocar o código encostando os celulares, ou use o QR code.',
  turnOnNfc: 'Ligar NFC',
  // S4: o botão abre os ajustes do Android, não liga nada sozinho.
  turnOnNfcHint: 'Abre os ajustes do celular',
  // Ler código. O iPhone não emite: com iPhone do outro lado, só a câmera (ux.md §11.19).
  readNfcTitle: 'Encoste este celular no outro, costas com costas',
  readNfcText:
    'O outro celular precisa estar mostrando o código na tela Conectar. Se ele for iPhone, use a câmera.',
  readIphoneTitle: 'Leia o código da outra pessoa',
  readIphoneText:
    'Se o outro celular for Android, toque em Aproximar do outro celular e encoste o topo do seu iPhone nas costas dele. Se for iPhone, use a câmera.',
  readCameraOnlyTitle: 'Leia o código da outra pessoa',
  readCameraOnlyText: 'Aponte a câmera para o código na tela da outra pessoa.',
  nfcTap: 'Aproximar do outro celular',
  useCamera: 'Usar a câmera',
  // A leitura por NFC que falhou no meio (a tag saiu do campo, ou não era do Sussurro).
  nfcReadFailed: 'Não deu para ler o código. Tente de novo ou use a câmera.',
  // Leitor de tela e o texto ao lado do Spinner: um código foi lido (QR ou NFC).
  codeRead: 'Código lido',
  // Cartão da pessoa lida (T15 a T18).
  cardCheck: 'Confira se é a pessoa que está com você.',
  connectWith: (first: string) => `Conectar com ${first}`,
  connectWithLabel: (name: string, handle: string) => `Conectar com ${name}, @${handle}`,
  cancel: 'Cancelar',
  alreadyConnected: 'Vocês já estão conectados.',
  // N20: o código lido venceu antes do "Conectar" (30 s), no lugar do T20.
  cardExpired: (first: string) => `O código de ${first} venceu. Leia o código de novo.`,
  // (dev, D15) Simulações: só no build de desenvolvimento.
  simulate: 'Simular um pedido recebido',
  simulateNfc: 'Simular um pedido recebido por NFC',
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
  continue: 'Continuar',
  openSettings: 'Abrir Ajustes',
  // Câmera (§4.12): T32 a T34.
  scannerTitle: 'Ler código',
  scannerHint: 'Aponte a câmera para o código da outra pessoa.',
  scannerHintAccept: (first: string) => `Aponte a câmera para o código na tela de ${first}.`,
  close: 'Fechar',
  cameraExplainTitle: 'Ler o código da outra pessoa',
  cameraExplainText: 'A câmera é usada só para ler o QR code.',
  cameraDeniedTitle: 'Câmera sem permissão',
  cameraDeniedText: 'Permita a câmera nos Ajustes ou peça para a outra pessoa ler o seu código.',
  // N28: câmera negada no aceite. Quem aceita lê o código de quem pediu (D7); sem "dele" ou "dela".
  cameraDeniedTextAccept: (first: string) =>
    `Para aceitar, permita a câmera nos Ajustes e leia o código na tela de ${first}.`,
  showMyCode: 'Mostrar meu código',
  // (4b) Código vencido ou adulterado (4.7 CA4): nada é criado.
  qrInvalid:
    'Este código venceu ou não é do Sussurro. Peça para a outra pessoa mostrar o código de novo.',
  // N22: no aceite, o código lido é de outra pessoa ou venceu (400 `PROXIMITY_TOKEN_INVALID`). Sem
  // "dele" ou "dela": o app não sabe o gênero.
  notTheirCode: (first: string) =>
    `Este código não é de ${first} ou já venceu. Leia o código na tela de ${first}.`,
  // Folha do pedido recebido (§4.11). Sem artigo antes do nome ("a Helena"): o app não sabe o gênero.
  sheetTitle: (first: string) => `${first} quer se conectar`,
  sheetConfirm: (first: string) => `Confirme só se ${first} estiver aí com você.`,
  accept: 'Aceitar',
  // Depois do "Aceitar": ler o código de quem pediu (D7).
  acceptRead: (first: string) => `Para aceitar, leia o código na tela de ${first}.`,
  // N24: na folha, Android com NFC ligado. Quem pediu pode estar num iPhone, que não emite.
  acceptReadNfc: (first: string) =>
    `Ou encoste este celular no de ${first}, costas com costas. Com iPhone, só a câmera funciona.`,
  decline: 'Recusar',
  expiresIn: (countdown: string) => `Expira em ${countdown}`,
  expired: (first: string) => `O pedido de ${first} expirou.`,
  // (4b) O pedido sumiu antes de vencer (cancelado por quem pediu).
  gone: (first: string) => `O pedido de ${first} não está mais disponível.`,
  // Leitor de tela (§7.3).
  announceCard: (name: string) => `${name}. Confira se é a pessoa que está com você.`,
  announceCardConnected: (name: string) => `${name}. Vocês já estão conectados.`,
  announceIncoming: (first: string) => `${first} quer se conectar com você.`,
  announceSent: 'Pedido enviado',
  announceConnected: 'Vocês estão conectados',
  announceNotConfirmed: 'Pedido recusado ou expirado',
  // Criador (p22).
  creatorTitle: 'Indisponível para criadores',
  creatorText: 'Contas de criador só publicam. Elas não se conectam nem seguem outras contas.',
  backToProfile: 'Voltar ao perfil',
} as const;
