import {
  type ConnectionMethod,
  type ConnectionRequest,
  type ConnectionRequestParty,
  type NearbyPerson,
  parseProximityQr,
  ProximityTokenValueSchema,
  proximityQrPayload,
} from '@sussurro/shared';
import { useToast } from '@sussurro/ui';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { announce, announceAfterFocus, announceAfterFocusMs } from './a11y';
import {
  acceptConnectionRequest,
  cancelConnectionRequest,
  createConnectionRequest,
  declineConnectionRequest,
  fetchConnectionRequest,
  resolveProximityToken,
  simulateIncomingRequest,
} from './api';
import { COPY, firstName } from './copy';
import { isSimulationEnabled } from './dev-tools';
import { type HaltReason, haltReasonFor, nativeErrorCode, TokenWaitCancelled } from './errors';
import { vibrate } from './haptics';
import { usePolling, useProximityToken } from './hooks';
import { useNfc } from './NfcProvider';
import { connectClock, connectTiming } from './timing';
import { useIncoming } from './useIncoming';
import {
  type NfcCapabilities,
  type NfcReadErrorCode,
  UNAVAILABLE_NFC_CAPABILITIES,
} from '../../../modules/sussurro-proximity';
import { isApiError, NetworkError } from '../../lib/api/errors';
import { messageForError, OFFLINE_MESSAGE } from '../../lib/error-messages';
import { useAuth, useSignedInUser } from '../auth/AuthProvider';
import { REPORT_SENT_MESSAGE } from '../moderation/ReportForm';
import { useBlockAccount } from '../moderation/useBlockAccount';
import { useNotifications } from '../notifications/NotificationsProvider';
import { usePostStore } from '../posts/post-store';
import { PROFILE_GONE_MESSAGE } from '../relations/useFollowToggle';

/** O seletor "Mostrar meu código | Ler código" (ADR 0013 §5). */
export type ConnectMode = 'show' | 'read';

/**
 * Estados da tela (ADR 0013 §5): o início (o modo do seletor), o cartão da pessoa lida, o
 * "Aguardando", o "não confirmou" e o "conectados".
 */
export type ConnectView =
  | { kind: 'start' }
  | { kind: 'card'; person: NearbyPerson; method: ConnectionMethod }
  | { kind: 'waiting'; request: ConnectionRequest }
  | { kind: 'notConfirmed'; request: ConnectionRequest }
  | { kind: 'connected'; other: ConnectionRequestParty; at: number };

/**
 * Como este celular usa o NFC (ADR 0013 §4 e §5):
 * - `emitter`: emite e lê (Android com HCE): o código vai também por NFC, e a leitura fica ligada
 *   enquanto o modo "Ler código" está aberto (reader mode contínuo);
 * - `reader`: só lê (iPhone): a leitura abre a folha do sistema pelo botão "Aproximar do outro celular";
 * - `none`: sem NFC, sem o módulo (Expo Go) ou ainda conferindo: só o QR code e a câmera.
 */
export type NfcRole = 'emitter' | 'reader' | 'none';

export function nfcRoleOf(caps: NfcCapabilities): NfcRole {
  if (!caps.available || !caps.supported) return 'none';
  if (caps.canEmit && caps.canRead) return 'emitter';
  if (caps.canRead) return 'reader';
  return 'none';
}

interface SessionState {
  mode: ConnectMode;
  view: ConnectView;
  halt: HaltReason | null;
  /** O "Conectar" (ou o aceite pelo cartão) ou o "Cancelar pedido" em andamento. */
  busy: 'connect' | 'cancel' | null;
  /**
   * Cada ida ao início muda `run`; `focus` diz se o foco vai ao título (só quando o controle focado
   * sumiu da tela: o cartão fechou, "Tentar de novo", "Cancelar pedido"…). Pelo seletor e na
   * abertura, o foco fica onde está (WCAG 3.2.2).
   */
  start: { run: number; focus: boolean };
}

type Action =
  | { type: 'mode'; mode: ConnectMode }
  | { type: 'view'; view: ConnectView }
  | { type: 'start'; mode: ConnectMode; focus: boolean }
  | { type: 'halt'; reason: HaltReason }
  | { type: 'resume' }
  | { type: 'busy'; value: SessionState['busy'] };

const START: ConnectView = { kind: 'start' };

function reducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case 'mode':
      return {
        ...state,
        mode: action.mode,
        view: START,
        start: { run: state.start.run + 1, focus: false },
      };
    case 'view':
      return { ...state, view: action.view };
    case 'start':
      return {
        ...state,
        mode: action.mode,
        view: START,
        start: { run: state.start.run + 1, focus: action.focus },
      };
    case 'halt':
      return { ...state, halt: action.reason, view: START, busy: null };
    case 'resume':
      return {
        ...state,
        halt: null,
        view: START,
        start: { run: state.start.run + 1, focus: true },
      };
    case 'busy':
      return { ...state, busy: action.value };
  }
}

/** Para que a câmera foi aberta: pedir (A lê o código de B) ou aceitar (B lê o código de A, D7). */
export type ScannerPurpose = { kind: 'request' } | { kind: 'accept'; request: ConnectionRequest };

export interface ScannerState {
  purpose: ScannerPurpose;
  error: string | null;
  busy: boolean;
}

/** De onde veio o código lido: o `method` do pedido é `nfc` só pelo NFC (ADR 0013 §2). */
type ReadSource = 'nfc' | 'camera' | 'link';

function methodOf(source: ReadSource): ConnectionMethod {
  return source === 'nfc' ? 'nfc' : 'qr';
}

/** Erros de leitura do NFC que não viram mensagem: a pessoa fechou a folha ou ela expirou. */
const SILENT_NFC_ERRORS: ReadonlySet<NfcReadErrorCode> = new Set(['cancelled', 'timeout']);

/** Chama o NFC sem deixar um erro do nativo derrubar a tela (o QR continua). */
function safely(call: () => void): void {
  try {
    call();
  } catch {
    // O QR code não depende do NFC (ADR 0013, N1).
  }
}

export interface UseConnectSessionOptions {
  /** O app está em primeiro plano (em background, tudo pausa e recomeça ao voltar). */
  live: boolean;
  /** Token do deep link `sussurro://c/{token}` (parâmetro `qr` da rota), ou `null`. */
  qrParam: string | null;
  /** O deep link já foi tratado (a rota guarda, para a tela não tratar duas vezes). */
  isQrHandled: (token: string) => boolean;
  onQrHandled: (token: string) => void;
}

/**
 * A tela Conectar inteira (ADR 0013 §5): o token renovado, mostrado no QR e emitido por NFC; a
 * leitura do código da outra pessoa (NFC ou câmera); o cartão dela; o pedido e o "Aguardando"; o
 * pedido recebido na folha, com o aceite pela leitura cruzada (D7); e os estados de erro. Montada só
 * com a aba em foco: sair da aba desmonta tudo (o NFC para de emitir e de ler) e a volta começa no
 * início. Em background, o mesmo, e tudo volta ao voltar.
 */
export function useConnectSession({
  live,
  qrParam,
  isQrHandled,
  onQrHandled,
}: UseConnectSessionOptions) {
  const { api, reloadUser } = useAuth();
  const { offerPush } = useNotifications();
  const user = useSignedInUser();
  const nfc = useNfc();
  const toast = useToast();
  const posts = usePostStore();
  const block = useBlockAccount();
  const [state, dispatch] = useReducer(reducer, user.emailVerified, (verified): SessionState => ({
    mode: 'show',
    view: START,
    halt: verified ? null : 'emailNotVerified',
    busy: null,
    start: { run: 0, focus: false },
  }));
  const [caps, setCaps] = useState<NfcCapabilities>(UNAVAILABLE_NFC_CAPABILITIES);
  /** Pedidos simulados em dev: o token da persona, que faz as vezes da leitura no aceite. */
  const [simulated, setSimulated] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [sheetError, setSheetError] = useState<{ id: string; message: string } | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  /** O pedido recebido cujo "Aceitar" foi tocado: a folha pede a leitura do código de quem pediu. */
  const [accepting, setAccepting] = useState<ConnectionRequest | null>(null);
  const [scanner, setScanner] = useState<ScannerState | null>(null);
  /** Um código lido está sendo conferido (`resolve`). */
  const [resolving, setResolving] = useState(false);
  /** Aviso da leitura por NFC no modo "Ler código" (a leitura falhou no meio, código vencido…). */
  const [readNotice, setReadNotice] = useState<string | null>(null);
  /** O formulário de denúncia aberto pela folha do pedido recebido. */
  const [report, setReport] = useState<{ handle: string; run: number } | null>(null);

  const active = live && state.halt === null;
  const role = nfcRoleOf(caps);

  const viewRef = useRef(state.view);
  const modeRef = useRef(state.mode);
  const busyRef = useRef(state.busy);
  const scannerRef = useRef(scanner);
  const acceptingRef = useRef(accepting);
  const resolvingRef = useRef(false);
  useEffect(() => {
    viewRef.current = state.view;
    modeRef.current = state.mode;
    busyRef.current = state.busy;
    scannerRef.current = scanner;
    acceptingRef.current = accepting;
  });

  /**
   * Erro que para a tela (429, Redis fora, sem rede, e-mail): `true` se parou. A espera pela vaga
   * das emissões cancelada (`TokenWaitCancelled`) também volta `true`, sem parar de novo: ela só
   * acontece porque a tela já parou, foi para o segundo plano ou fechou, e quem esperava termina
   * sem Toast nem mensagem (PROX-68).
   */
  const halt = useCallback((error: unknown): boolean => {
    if (error instanceof TokenWaitCancelled) return true;
    const reason = haltReasonFor(error);
    if (reason === null) return false;
    dispatch({ type: 'halt', reason });
    setScanner(null);
    setAccepting(null);
    return true;
  }, []);

  // Com a tela parada (18 a 20), o token de antes sai: o "Tentar de novo" começa com o QR no
  // carregando e o NFC sem emitir, até a nova emissão (C4).
  const { token, refresh: refreshOwnToken } = useProximityToken(
    api,
    active,
    (error) => {
      if (!halt(error)) dispatch({ type: 'halt', reason: 'unavailable' });
    },
    state.halt !== null,
  );
  const tokenReady = token !== null;

  /** A tela Conectar ainda está montada (sair da aba ou da conta a desmonta). */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  /** A tela está ativa (em primeiro plano e sem parada), lido depois de qualquer `await`. */
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  /**
   * Repete uma vez depois de renovar o token se o servidor disse "tela fechada" (409). Com a janela
   * das emissões cheia, a renovação espera a vaga (PROX-68), e a ação fica no carregando.
   *
   * O 409 que chega depois de a tela desmontar (sair da aba, sair da conta) não renova nem repete,
   * e o mesmo vale se ela desmontar durante a renovação (MÉDIO do `seguranca`): a repetição sairia
   * com a sessão de agora, que pode ser de outra conta, e criaria um pedido que ninguém fez. Com a
   * tela inativa (parada ou em segundo plano), o mesmo: o `refresh` não emite (`useProximityToken`),
   * e a repetição não sai nem quando o `refresh` aproveita uma emissão que já estava em voo antes da
   * inativação (BAIXO do `seguranca`). A ação termina em silêncio (`TokenWaitCancelled`, que o
   * `halt` trata).
   */
  const withScreenOpen = useCallback(
    async <T>(call: () => Promise<T>): Promise<T> => {
      /** Lido sempre de novo: a tela pode desmontar ou ficar inativa durante qualquer `await`. */
      const closed = (): boolean => !mountedRef.current || !activeRef.current;
      try {
        return await call();
      } catch (error) {
        if (!isApiError(error, 'PROXIMITY_SCREEN_CLOSED')) throw error;
        if (closed()) throw new TokenWaitCancelled();
        await refreshOwnToken();
        if (closed()) throw new TokenWaitCancelled();
        return call();
      }
    },
    [refreshOwnToken],
  );

  // --- NFC: capacidades, emissão e leitura (ADR 0013 §4 e §5) -------------------------------------

  // Na abertura e a cada volta do background (a pessoa pode ter ligado o NFC nos Ajustes).
  useEffect(() => {
    if (!live) return undefined;
    let cancelled = false;
    nfc
      .getNfcCapabilities()
      .then((next) => {
        if (!cancelled) setCaps(next);
      })
      .catch(() => {
        if (!cancelled) setCaps(UNAVAILABLE_NFC_CAPABILITIES);
      });
    return () => {
      cancelled = true;
    };
  }, [live, nfc]);

  // Com a câmera ou o formulário de denúncia por cima, o QR não está à vista: o NFC também para.
  const showingMyCode =
    report === null &&
    scanner === null &&
    ((state.mode === 'show' && state.view.kind === 'start') || state.view.kind === 'waiting');
  /** O código que este celular emite por NFC agora (o mesmo do QR na tela), ou `null`. */
  const emitPayload =
    active && role === 'emitter' && caps.enabled && showingMyCode && token !== null
      ? proximityQrPayload(token)
      : null;
  const emitting = emitPayload !== null;
  // Token novo: o nativo troca o código sem parar antes (sem buraco na emissão).
  useEffect(() => {
    if (emitPayload === null) return;
    safely(() => {
      nfc.setEmittedPayload(emitPayload);
    });
  }, [emitPayload, nfc]);
  // Saiu da tela, foi para o background, trocou de modo ou o NFC desligou: para de emitir.
  useEffect(() => {
    if (!emitting) return undefined;
    return () => {
      safely(() => {
        nfc.setEmittedPayload(null);
      });
    };
  }, [emitting, nfc]);

  // Qualquer leitura em curso para ao sair da tela e no background (a do iPhone também).
  useEffect(() => {
    if (!active) return undefined;
    return () => {
      safely(() => {
        nfc.stopReading();
      });
    };
  }, [active, nfc]);

  // --- Pedido recebido: polling e a folha -----------------------------------------------------------

  const incoming = useIncoming(api, active, (entry, expired) => {
    const first = firstName(entry.request.other.name);
    if (acceptingRef.current?.id === entry.request.id) setAccepting(null);
    const current = scannerRef.current;
    if (current?.purpose.kind === 'accept' && current.purpose.request.id === entry.request.id) {
      setScanner(null);
    }
    toast.show({ message: expired ? COPY.expired(first) : COPY.gone(first) });
  });
  const head = incoming.head;
  const showSheet = head !== null && scanner === null && report === null;
  /** O "Aceitar" tocado na folha que está na tela (a leitura do código de quem pediu). */
  const acceptingHead = showSheet && accepting !== null && accepting.id === head.request.id;

  // Pedido recebido: vibração leve e o anúncio, depois do foco no título da folha (ux.md §11.8).
  const cueId = head === null || report !== null ? null : head.request.id;
  const headName = head?.request.other.name ?? null;
  const cuedRef = useRef<string | null>(null);
  useEffect(() => {
    if (cueId === null || headName === null || cuedRef.current === cueId) return undefined;
    cuedRef.current = cueId;
    vibrate('incoming');
    return announceAfterFocus(COPY.announceIncoming(firstName(headName)));
  }, [cueId, headName]);

  // A leitura contínua (Android): no modo "Ler código", sem a folha por cima, ou na folha depois do
  // "Aceitar". Com o reader mode ligado, este celular não é lido por outro (ADR 0013 §4).
  const readerOn =
    active &&
    role === 'emitter' &&
    caps.enabled &&
    scanner === null &&
    (acceptingHead ||
      (!showSheet && state.mode === 'read' && state.view.kind === 'start' && report === null));
  useEffect(() => {
    if (!readerOn) return undefined;
    let stopped = false;
    nfc.startReading().catch((error: unknown) => {
      if (stopped) return;
      if (nativeErrorCode(error) === 'ERR_NFC_DISABLED') {
        setCaps((current) => ({ ...current, enabled: false }));
      }
      // Sem suporte ou sem Activity: segue com a câmera, sem mensagem.
    });
    return () => {
      stopped = true;
      safely(() => {
        nfc.stopReading();
      });
    };
  }, [nfc, readerOn]);

  // --- Pedido (A) ---------------------------------------------------------------------------------

  const markConnected = useCallback(
    (other: ConnectionRequestParty) => {
      dispatch({ type: 'view', view: { kind: 'connected', other, at: connectClock.now() } });
      posts.showPostsOf(other.handle);
      // Conexão nova: o Início busca as publicações dela na próxima volta ao foco (ux.md §12.2).
      posts.markFeedStale();
      vibrate('connected');
      reloadUser().catch(() => undefined);
      // Primeira conexão: o pedido contextual de notificações (6.4 CA1), uma vez só.
      offerPush();
    },
    [offerPush, posts, reloadUser],
  );

  // "Vocês estão conectados": o foco vai ao título do p14, e o anúncio sai depois dele (ux.md §11.8).
  const connectedKey =
    state.view.kind === 'connected' ? `${state.view.other.handle}:${String(state.view.at)}` : null;
  useEffect(() => {
    if (connectedKey === null) return undefined;
    return announceAfterFocus(COPY.announceConnected);
  }, [connectedKey]);

  // O cartão: o foco vai ao nome, e o anúncio sai depois dele.
  const cardPerson = state.view.kind === 'card' ? state.view.person : null;
  const cardKey =
    cardPerson === null ? null : `${cardPerson.handle}:${String(cardPerson.alreadyConnected)}`;
  const cardAnnouncement =
    cardPerson === null
      ? null
      : cardPerson.alreadyConnected
        ? COPY.announceCardConnected(cardPerson.name)
        : COPY.announceCard(cardPerson.name);
  useEffect(() => {
    if (cardKey === null || cardAnnouncement === null) return undefined;
    return announceAfterFocus(cardAnnouncement);
  }, [cardAnnouncement, cardKey]);

  const markNotConfirmed = useCallback((request: ConnectionRequest) => {
    dispatch({ type: 'view', view: { kind: 'notConfirmed', request } });
    announce(COPY.announceNotConfirmed);
  }, []);

  const afterCreated = useCallback(
    (request: ConnectionRequest) => {
      if (request.status === 'accepted') {
        markConnected(request.other);
      } else if (request.status === 'pending') {
        dispatch({ type: 'view', view: { kind: 'waiting', request } });
        announce(COPY.announceSent);
      } else {
        markNotConfirmed(request);
      }
    },
    [markConnected, markNotConfirmed],
  );

  /** De volta ao início do modo (o cartão fechou, "Tentar de novo"…), com o foco no título. */
  const backTo = useCallback((mode: ConnectMode) => {
    dispatch({ type: 'start', mode, focus: true });
  }, []);

  // --- Aceite (B) ---------------------------------------------------------------------------------

  /**
   * O aceite com o token de quem pediu, lido agora (D7). O token de outra pessoa (ou vencido) dá 400
   * `PROXIMITY_TOKEN_INVALID`: a mensagem aparece onde a leitura aconteceu (a câmera, que continua
   * aberta, ou a folha), e o pedido continua.
   */
  const acceptWith = useCallback(
    async (request: ConnectionRequest, observedToken: string, source: ReadSource | 'card') => {
      const first = firstName(request.other.name);
      setSheetBusy(true);
      setSheetError(null);
      const closeReading = () => {
        setAccepting(null);
        setScanner(null);
      };
      const fail = (message: string) => {
        if (source === 'camera' && scannerRef.current !== null) {
          setScanner((current) =>
            current === null ? null : { ...current, busy: false, error: message },
          );
        } else {
          setScanner(null);
          setSheetError({ id: request.id, message });
        }
      };
      try {
        const result = await withScreenOpen(() =>
          acceptConnectionRequest(api, request.id, observedToken),
        );
        incoming.dismiss(request.id);
        closeReading();
        if (result.status === 'accepted') markConnected(result.other);
        else toast.show({ message: COPY.expired(first) });
      } catch (error) {
        if (isApiError(error, 'REQUEST_EXPIRED')) {
          incoming.dismiss(request.id);
          closeReading();
          toast.show({ message: COPY.expired(first) });
        } else if (isApiError(error, 'NOT_FOUND')) {
          incoming.dismiss(request.id);
          closeReading();
          toast.show({ message: COPY.gone(first) });
        } else if (isApiError(error, 'PROXIMITY_TOKEN_INVALID')) {
          fail(COPY.notTheirCode(first));
        } else if (error instanceof NetworkError) {
          fail(OFFLINE_MESSAGE);
        } else if (isApiError(error, 'RATE_LIMITED')) {
          fail(messageForError(error));
        } else if (!halt(error)) {
          fail(messageForError(error));
        }
      } finally {
        setSheetBusy(false);
      }
    },
    [api, halt, incoming, markConnected, toast, withScreenOpen],
  );

  // --- Código lido (QR, NFC ou deep link) ---------------------------------------------------------

  const readProblem = useCallback(
    (message: string, source: ReadSource) => {
      if (source === 'camera') {
        setScanner((current) =>
          current === null ? null : { ...current, busy: false, error: message },
        );
      } else if (source === 'nfc') {
        setReadNotice(message);
      } else {
        toast.show({ message, variant: 'error' });
      }
    },
    [toast],
  );

  /**
   * O código da outra pessoa, para pedir: primeiro o `resolve` (não conta como falha de token);
   * código vencido ou de outro app não cria nada (4.7 CA4). Depois, o cartão: nada é enviado sem o
   * toque em "Conectar", também pelo deep link e pela tag lida com o app fechado.
   */
  const readForRequest = useCallback(
    async (code: string, source: ReadSource) => {
      if (resolvingRef.current) return;
      resolvingRef.current = true;
      setResolving(true);
      setReadNotice(null);
      try {
        const person = (await withScreenOpen(() => resolveProximityToken(api, code))).items[0];
        if (person === undefined) {
          readProblem(COPY.qrInvalid, source);
          return;
        }
        setScanner(null);
        dispatch({ type: 'view', view: { kind: 'card', person, method: methodOf(source) } });
      } catch (error) {
        if (halt(error)) return;
        readProblem(
          error instanceof NetworkError ? OFFLINE_MESSAGE : messageForError(error),
          source,
        );
      } finally {
        resolvingRef.current = false;
        setResolving(false);
      }
    },
    [api, halt, readProblem, withScreenOpen],
  );

  /** "Código lido": vibração e o anúncio, na hora (o cartão ou o resultado vêm depois). */
  const cueRead = useCallback(() => {
    vibrate('read');
    announce(COPY.codeRead);
  }, []);

  /** Um código lido por NFC vai para o aceite em curso ou para o pedido (modo "Ler código"). */
  const onNfcCode = useCallback(
    (code: string) => {
      if (scannerRef.current !== null) return;
      const request = acceptingRef.current;
      if (request !== null) {
        cueRead();
        void acceptWith(request, code, 'nfc');
        return;
      }
      if (modeRef.current !== 'read' || viewRef.current.kind !== 'start' || resolvingRef.current) {
        return;
      }
      cueRead();
      void readForRequest(code, 'nfc');
    },
    [acceptWith, cueRead, readForRequest],
  );

  const onNfcError = useCallback((code: NfcReadErrorCode) => {
    if (SILENT_NFC_ERRORS.has(code)) return;
    if (code === 'disabled' || code === 'unsupported') {
      setCaps((current) => (code === 'disabled' ? { ...current, enabled: false } : current));
      return;
    }
    const request = acceptingRef.current;
    if (request !== null) setSheetError({ id: request.id, message: COPY.nfcReadFailed });
    else setReadNotice(COPY.nfcReadFailed);
  }, []);

  const nfcHandlers = useRef({ onNfcCode, onNfcError });
  useEffect(() => {
    nfcHandlers.current = { onNfcCode, onNfcError };
  });
  useEffect(() => {
    const read = nfc.addListener('onNfcRead', ({ uri }) => {
      const code = parseProximityQr(uri);
      if (code !== null) nfcHandlers.current.onNfcCode(code);
    });
    const failed = nfc.addListener('onNfcReadError', ({ code }) => {
      nfcHandlers.current.onNfcError(code);
    });
    const changed = nfc.addListener('onNfcStateChange', ({ enabled }) => {
      setCaps((current) => ({ ...current, enabled }));
      if (enabled) setReadNotice(null);
    });
    return () => {
      read.remove();
      failed.remove();
      changed.remove();
    };
  }, [nfc]);

  /** iPhone: "Aproximar do outro celular" abre a folha do sistema (fecha sozinha depois do código). */
  const tapNfc = useCallback(() => {
    setReadNotice(null);
    nfc.startReading().catch(() => {
      const request = acceptingRef.current;
      if (request !== null) setSheetError({ id: request.id, message: COPY.nfcReadFailed });
      else setReadNotice(COPY.nfcReadFailed);
    });
  }, [nfc]);

  // --- O cartão e o pedido (A) ---------------------------------------------------------------------

  /**
   * "Conectar com Caio" no cartão: o pedido com o token lido e o caminho da leitura. Se Caio já me
   * pediu (a corrida A→B ∥ B→A), o código lido dele é a leitura cruzada do aceite (D7).
   */
  const connectCard = useCallback(async () => {
    const view = viewRef.current;
    if (view.kind !== 'card' || busyRef.current !== null) return;
    const { person, method } = view;
    if (person.alreadyConnected) return;
    dispatch({ type: 'busy', value: 'connect' });
    try {
      const fromThem = incoming.findFrom(person.handle);
      if (fromThem !== null) {
        await acceptWith(fromThem.request, person.token, 'card');
        return;
      }
      afterCreated(await withScreenOpen(() => createConnectionRequest(api, person.token, method)));
    } catch (error) {
      if (isApiError(error, 'ALREADY_CONNECTED')) {
        dispatch({
          type: 'view',
          view: { ...view, person: { ...person, alreadyConnected: true } },
        });
      } else if (isApiError(error, 'PROXIMITY_TOKEN_INVALID')) {
        // O código lido venceu (30 s) antes do "Conectar": ler de novo. O `backTo` leva o foco ao
        // início; o Toast é anunciado depois do foco, para a leitura não cortá-lo (ux.md §11.19, S1).
        backTo('read');
        toast.show({
          message: COPY.cardExpired(firstName(person.name)),
          announceAfterMs: announceAfterFocusMs(),
        });
      } else if (error instanceof NetworkError) {
        toast.show({ message: OFFLINE_MESSAGE, variant: 'error' });
      } else if (!halt(error)) {
        toast.show({ message: messageForError(error), variant: 'error' });
      }
    } finally {
      dispatch({ type: 'busy', value: null });
    }
  }, [acceptWith, afterCreated, api, backTo, halt, incoming, toast, withScreenOpen]);

  // "Aguardando": polling de 2 s do meu pedido.
  const waitingId = state.view.kind === 'waiting' ? state.view.request.id : null;
  usePolling(
    async () => {
      if (waitingId === null) return;
      const isCurrent = () => {
        const view = viewRef.current;
        return view.kind === 'waiting' && view.request.id === waitingId;
      };
      try {
        const request = await fetchConnectionRequest(api, waitingId);
        if (!isCurrent()) return;
        if (request.status === 'accepted') markConnected(request.other);
        else if (request.status !== 'pending') markNotConfirmed(request);
      } catch (error) {
        const view = viewRef.current;
        if (isApiError(error, 'NOT_FOUND') && view.kind === 'waiting' && isCurrent()) {
          markNotConfirmed(view.request);
        }
      }
    },
    connectTiming.pollMs,
    active && waitingId !== null,
  );

  const cancelRequest = useCallback(async () => {
    const view = viewRef.current;
    if (view.kind !== 'waiting') return;
    dispatch({ type: 'busy', value: 'cancel' });
    try {
      const result = await cancelConnectionRequest(api, view.request.id);
      // B pode ter aceitado um instante antes: aí já são conexão.
      if (result.status === 'accepted') markConnected(result.other);
      else backTo(modeRef.current);
    } catch (error) {
      if (isApiError(error, 'NOT_FOUND')) backTo(modeRef.current);
      else toast.show({ message: messageForError(error), variant: 'error' });
    } finally {
      dispatch({ type: 'busy', value: null });
    }
  }, [api, backTo, markConnected, toast]);

  // --- Pedido recebido (B) -------------------------------------------------------------------------

  /**
   * "Aceitar" (D7): a folha pede a leitura do código de quem pediu (NFC ou câmera). Com o cartão da
   * mesma pessoa na tela, o código já lido serve. Na simulação em dev, o token devolvido pela rota
   * faz as vezes da leitura.
   */
  const acceptHead = useCallback(async () => {
    if (head === null || sheetBusy) return;
    const { request } = head;
    const simulatedToken = simulated.get(request.id);
    if (simulatedToken !== undefined) {
      await acceptWith(request, simulatedToken, 'card');
      return;
    }
    const view = viewRef.current;
    if (view.kind === 'card' && view.person.handle === request.other.handle) {
      await acceptWith(request, view.person.token, 'card');
      return;
    }
    setSheetError(null);
    setAccepting(request);
  }, [acceptWith, head, sheetBusy, simulated]);

  /** "Recusar": a folha fecha na hora. Quem pediu só vê "não confirmou". */
  const declineHead = useCallback(async () => {
    if (head === null) return;
    const { request } = head;
    incoming.dismiss(request.id);
    setAccepting(null);
    try {
      await declineConnectionRequest(api, request.id);
    } catch (error) {
      if (!isApiError(error, 'NOT_FOUND')) {
        toast.show({ message: messageForError(error), variant: 'error' });
      }
    }
  }, [api, head, incoming, toast]);

  /** ‹Bloquear› na folha: o `Alert` do perfil; depois do 204, o pedido sai junto (o servidor o cancela). */
  const blockHead = useCallback(() => {
    if (head === null) return;
    const { request } = head;
    block(
      { handle: request.other.handle },
      {
        onBlocked: () => {
          incoming.dismiss(request.id);
          if (acceptingRef.current?.id === request.id) setAccepting(null);
        },
      },
    );
  }, [block, head, incoming]);

  /** ‹Denunciar› na folha: o formulário por cima da tela Conectar (a sessão continua). */
  const reportHead = useCallback(() => {
    if (head === null) return;
    setReport((current) => ({ handle: head.request.other.handle, run: (current?.run ?? 0) + 1 }));
  }, [head]);

  // --- Câmera ----------------------------------------------------------------------------------------

  /** Leitura da câmera: o conteúdo precisa ser `sussurro://c/{token}` (senão, nada é enviado). */
  const onScanned = useCallback(
    async (data: string) => {
      const current = scannerRef.current;
      if (current === null || current.busy) return;
      const code = parseProximityQr(data);
      if (code === null) {
        if (current.error !== COPY.qrInvalid) setScanner({ ...current, error: COPY.qrInvalid });
        return;
      }
      const next = { ...current, busy: true, error: null };
      scannerRef.current = next;
      setScanner(next);
      cueRead();
      if (current.purpose.kind === 'accept') {
        await acceptWith(current.purpose.request, code, 'camera');
      } else {
        await readForRequest(code, 'camera');
      }
    },
    [acceptWith, cueRead, readForRequest],
  );

  // --- Deep link (`sussurro://c/{token}`, também a tag lida com o app fechado) --------------------

  const readForRequestRef = useRef(readForRequest);
  const linkRef = useRef({ isQrHandled, onQrHandled });
  useEffect(() => {
    readForRequestRef.current = readForRequest;
    linkRef.current = { isQrHandled, onQrHandled };
  });
  useEffect(() => {
    if (qrParam === null || !active || !tokenReady) return;
    if (linkRef.current.isQrHandled(qrParam)) return;
    linkRef.current.onQrHandled(qrParam);
    const code = qrParam;
    void Promise.resolve().then(() => {
      dispatch({ type: 'mode', mode: 'read' });
      if (ProximityTokenValueSchema.safeParse(code).success) {
        void readForRequestRef.current(code, 'link');
      } else {
        toast.show({ message: COPY.qrInvalid, variant: 'error' });
      }
    });
  }, [active, qrParam, toast, tokenReady]);

  // --- Simulações (só no build de desenvolvimento, D15) --------------------------------------------

  const simulationEnabled = isSimulationEnabled();
  const simulate = useCallback(
    async (method: ConnectionMethod) => {
      try {
        const result = await simulateIncomingRequest(api, method);
        setSimulated((current) => new Map([...current, [result.request.id, result.observedToken]]));
        incoming.inject(result.request);
      } catch (error) {
        toast.show({ message: messageForError(error), variant: 'error' });
      }
    },
    [api, incoming, toast],
  );

  // --- Estados de erro ------------------------------------------------------------------------------

  const resume = useCallback(async () => {
    if (state.halt === 'emailNotVerified') {
      const refreshed = await reloadUser().catch(() => null);
      if (refreshed?.emailVerified !== true) {
        toast.show({ message: COPY.emailText, variant: 'error' });
        return;
      }
    }
    dispatch({ type: 'resume' });
  }, [reloadUser, state.halt, toast]);

  const incomingError =
    sheetError !== null && sheetError.id === head?.request.id ? sheetError.message : null;

  return {
    user,
    mode: state.mode,
    view: state.view,
    halt: state.halt,
    busy: state.busy,
    token,
    resolving,
    /** O NFC deste celular: o papel, se está ligado e se o código está saindo por ele agora. */
    nfc: { role, enabled: caps.enabled, emitting },
    readNotice,
    /** Foco no título do início (ux.md §11.8): só quando o controle focado sumiu da tela. */
    startFocus: { key: `inicio:${String(state.start.run)}`, enabled: state.start.focus },
    incoming: showSheet
      ? {
          request: head.request,
          secondsLeft: incoming.secondsLeft,
          error: incomingError,
          busy: sheetBusy,
          /** Depois do "Aceitar": a folha pede a leitura do código de quem pediu. */
          reading: acceptingHead,
        }
      : null,
    scanner,
    report,
    simulationEnabled,
    actions: {
      setMode: (mode: ConnectMode) => {
        setReadNotice(null);
        dispatch({ type: 'mode', mode });
      },
      turnOnNfc: () => {
        safely(() => {
          nfc.openNfcSettings();
        });
      },
      tapNfc,
      connectCard: () => {
        void connectCard();
      },
      /** "Cancelar" ou "Voltar" no cartão: de volta à leitura, com o foco no título. */
      closeCard: () => {
        if (busyRef.current !== null) return;
        backTo('read');
      },
      cancelRequest: () => {
        void cancelRequest();
      },
      retryAfterNotConfirmed: () => {
        backTo('read');
      },
      backToStart: () => {
        backTo(state.mode);
      },
      accept: () => {
        void acceptHead();
      },
      decline: () => {
        void declineHead();
      },
      blockIncoming: blockHead,
      reportIncoming: reportHead,
      /** ✕ ou voltar na folha: fecha sem responder (o pedido segue até vencer). */
      closeSheet: () => {
        if (head !== null) incoming.dismiss(head.request.id);
        setAccepting(null);
      },
      /** "Usar a câmera": para pedir (modo "Ler código") ou para aceitar (a folha). */
      openScanner: () => {
        setReadNotice(null);
        const request = acceptingRef.current;
        setScanner({
          purpose: request === null ? { kind: 'request' } : { kind: 'accept', request },
          error: null,
          busy: false,
        });
      },
      closeScanner: () => {
        setScanner(null);
      },
      onScanned: (data: string) => {
        void onScanned(data);
      },
      /** "Mostrar meu código" (câmera negada). */
      showMyCode: () => {
        setScanner(null);
        setAccepting(null);
        dispatch({ type: 'mode', mode: 'show' });
      },
      closeReport: () => {
        setReport(null);
      },
      reportSent: () => {
        setReport(null);
        toast.show({ message: REPORT_SENT_MESSAGE, variant: 'success' });
      },
      reportGone: () => {
        setReport(null);
        toast.show({ message: PROFILE_GONE_MESSAGE, variant: 'error' });
      },
      simulate: () => {
        void simulate('qr');
      },
      simulateNfc: () => {
        void simulate('nfc');
      },
      resume: () => {
        void resume();
      },
    },
  };
}

export type ConnectSession = ReturnType<typeof useConnectSession>;
