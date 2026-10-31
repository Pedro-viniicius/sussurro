import {
  type ConnectionRequest,
  type ConnectionRequestParty,
  type NearbyPerson,
  parseProximityQr,
  ProximityTokenValueSchema,
} from '@sussurro/shared';
import { useToast } from '@sussurro/ui';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Linking, Platform } from 'react-native';

import { announce, announceAfterFocus, announceAfterFocusMs } from './a11y';
import {
  acceptConnectionRequest,
  cancelConnectionRequest,
  createConnectionRequest,
  declineConnectionRequest,
  fetchConnectionRequest,
  resolveQrToken,
  simulateIncomingRequest,
  simulateTouch,
} from './api';
import { COPY, firstName } from './copy';
import { isSimulationEnabled } from './dev-tools';
import { type HaltReason, haltReasonFor, nativeErrorCode } from './errors';
import { vibrate } from './haptics';
import { usePolling, useProximityToken } from './hooks';
import { useProximityRadio } from './RadioProvider';
import { connectClock, connectTiming } from './timing';
import { TOUCH_CALIBRATION } from './touch-calibration';
import type { TouchReceiver } from './touch-detector';
import { useIncoming } from './useIncoming';
import { type TouchCard, useTouch } from './useTouch';
import type { AdvertiseOptions, ProximityCapabilities } from '../../../modules/sussurro-proximity';
import { isApiError, NetworkError } from '../../lib/api/errors';
import { messageForError, OFFLINE_MESSAGE } from '../../lib/error-messages';
import { useAuth, useSignedInUser } from '../auth/AuthProvider';
import { REPORT_SENT_MESSAGE } from '../moderation/ReportForm';
import { blockedMessage, useBlockAccount } from '../moderation/useBlockAccount';
import { useNotifications } from '../notifications/NotificationsProvider';
import { usePostStore } from '../posts/post-store';
import { PROFILE_GONE_MESSAGE } from '../relations/useFollowToggle';

/** O seletor "Encostar | QR code" (D3 revisto, D-UX22). */
export type ConnectMode = 'touch' | 'qr';

/**
 * Estados da tela (ux.md §11.4). O Pronto e as suas fases (6 a 10) são `ready`; a fase vem do
 * `useTouch`. O "Sem suporte" (5) abre direto no QR (`unsupported`).
 */
export type ConnectView =
  | { kind: 'checking' }
  | { kind: 'btExplain' }
  | { kind: 'btDenied' }
  | { kind: 'btOff' }
  | { kind: 'btLocationOff' }
  | { kind: 'btUnsupported' }
  | { kind: 'ready' }
  | { kind: 'card'; card: TouchCard; alreadyConnected: boolean }
  | { kind: 'waiting'; request: ConnectionRequest }
  | { kind: 'notConfirmed'; request: ConnectionRequest }
  | { kind: 'connected'; other: ConnectionRequestParty; at: number };

/**
 * Por que a tela foi (ou vai) para o Pronto (ux.md §11.8). O foco só vai ao título do Pronto quando
 * o controle que tinha o foco sumiu da tela:
 * - `cardClosed`: Cancelar, Voltar ou Recusar no cartão, o cartão vencido ou o pedido do cartão que
 *   acabou;
 * - `restart`: "Conectar outra pessoa", "Tentar de novo", "Voltar" e "Cancelar pedido";
 * - `bluetooth`: "Continuar" da explicação, a volta dos Ajustes e o Bluetooth ligado.
 *
 * Na abertura da aba (`open`) e pelo seletor (`selector`), o foco fica onde está (WCAG 3.2.2). A
 * volta do background nem passa por aqui: o estado não muda.
 */
export type ReadyReason = 'open' | 'selector' | 'cardClosed' | 'restart' | 'bluetooth';

const FOCUS_READY_TITLE: ReadonlySet<ReadyReason> = new Set(['cardClosed', 'restart', 'bluetooth']);

interface SessionState {
  mode: ConnectMode;
  view: ConnectView;
  halt: HaltReason | null;
  /** @ do pedido em envio, ou "cancel" (para o botão em carregamento). */
  busy: string | null;
  /** Este celular não consegue encostar (sem BLE, sem o módulo ou sem anunciar, P6). */
  unsupported: boolean;
  /** O motivo da última ida ao Pronto; `run` muda a cada motivo novo (o foco pode ir de novo). */
  ready: { reason: ReadyReason; run: number };
}

type Action =
  | { type: 'mode'; mode: ConnectMode }
  /** `reason`: a troca leva ao Pronto (direto ou pelo Verificando); sem ele, o motivo não muda. */
  | { type: 'view'; view: ConnectView; reason?: ReadyReason | undefined }
  | { type: 'unsupported' }
  | { type: 'halt'; reason: HaltReason }
  | { type: 'resume' }
  | { type: 'busy'; value: string | null };

const CHECKING: ConnectView = { kind: 'checking' };
const READY: ConnectView = { kind: 'ready' };
const UNSUPPORTED: ConnectView = { kind: 'btUnsupported' };

/** Estados em que a varredura segue ligada: uma sessão contínua por visita à aba (P7). */
const SCANNING_VIEWS: ReadonlySet<ConnectView['kind']> = new Set([
  'ready',
  'card',
  'waiting',
  'notConfirmed',
  'connected',
]);

function withReadyReason(state: SessionState, reason: ReadyReason | undefined) {
  return reason === undefined ? state.ready : { reason, run: state.ready.run + 1 };
}

function reducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case 'mode':
      return {
        ...state,
        mode: action.mode,
        view: action.mode === 'touch' && state.unsupported ? UNSUPPORTED : CHECKING,
        ready: withReadyReason(state, 'selector'),
      };
    case 'view':
      return { ...state, view: action.view, ready: withReadyReason(state, action.reason) };
    case 'unsupported':
      // P6: a aba abre direto no QR, com a faixa T30.
      return { ...state, unsupported: true, mode: 'qr', view: CHECKING };
    case 'halt':
      return { ...state, halt: action.reason, view: CHECKING, busy: null };
    case 'resume':
      // "Tentar de novo" (estados 18 a 20) some da tela: o foco vai ao título do Pronto.
      return { ...state, halt: null, view: CHECKING, ready: withReadyReason(state, 'restart') };
    case 'busy':
      return { ...state, busy: action.value };
  }
}

/**
 * Bloquear e denunciar pelo cartão (ux.md §11.14; ADR 0012, A2 rev. 1, R1-5 e R1-9): o estado do
 * cartão na tela. Vale para o cartão `cardId`; um cartão novo começa do zero.
 */
interface CardModeration {
  /** `@handle:matchedAt` do cartão. */
  cardId: string;
  handle: string;
  /** O `Alert` de "Bloquear @…?" está na tela (M1). */
  alertOpen: boolean;
  /** O formulário de denúncia: `closing` enquanto o `Modal` sai (o iOS espera o `onDismiss`). */
  form: 'closed' | 'open' | 'closing';
  /** Muda a cada abertura: o formulário começa vazio (o texto de antes não volta, M12). */
  formRun: number;
  /** O T46 no formulário: aberto pelo 11, pelo 14 ou pelo Bloqueado, nunca pelo 12. */
  formNote: boolean;
  /** "Bloquear" confirmado e em andamento (M3). */
  blocking: boolean;
  /** 204 no 11 ou no 14: o cartão é o Bloqueado (M4). */
  blocked: boolean;
  /** O 14 passou do prazo do cartão (ou o par acabou, 404): a linha some e o pedido fica (M10, M14). */
  lineGone: boolean;
  /** Muda para o foco voltar ao cabeçalho do cartão (M9, M12, M14). */
  focusRun: number;
  /** O foco ficou na linha (o `Alert` cancelado, M2, ou o erro do bloqueio, M6). */
  focusOnLine: boolean;
  /** O pedido do cartão sumiu com o `Alert`, o formulário ou o bloqueio em andamento (M15). */
  heldGone: { message: string; request: ConnectionRequest } | null;
}

const NO_MODERATION: CardModeration = {
  cardId: '',
  handle: '',
  alertOpen: false,
  form: 'closed',
  formRun: 0,
  formNote: false,
  blocking: false,
  blocked: false,
  lineGone: false,
  focusRun: 0,
  focusOnLine: false,
  heldGone: null,
};

/** O cartão de um casamento (o mesmo @ pode casar de novo depois). */
function cardIdOf(card: TouchCard): string {
  return `${card.person.handle}:${String(card.matchedAt)}`;
}

/** O cartão está segurado (M15): o `Alert`, o formulário ou o bloqueio em andamento. */
function isHeld(moderation: CardModeration): boolean {
  return moderation.alertOpen || moderation.form !== 'closed' || moderation.blocking;
}

/** Como terminou o `Alert`, o bloqueio ou o formulário (ux.md §11.14, M2, M6, M7, M9, M10, M12). */
type CardOutcome =
  | { kind: 'alertCancelled' }
  | { kind: 'blockFailed' }
  | { kind: 'formCancelled' }
  | { kind: 'sent' }
  | { kind: 'gone'; from: 'alert' | 'form' };

/** Para que a câmera foi aberta: pedir (A lê o QR de B) ou aceitar (B lê o QR de A, D7). */
export type ScannerPurpose = { kind: 'auto' } | { kind: 'accept'; request: ConnectionRequest };

export interface ScannerState {
  purpose: ScannerPurpose;
  error: string | null;
  busy: boolean;
}

/** O que as capacidades do Bluetooth permitem agora (ux.md §11.4, estados 2 a 5). */
export function capabilityView(
  caps: ProximityCapabilities,
  options: { afterRequest?: boolean } = {},
): 'btExplain' | 'btDenied' | 'btOff' | 'btLocationOff' | 'ready' | 'unsupported' {
  if (!caps.available || !caps.bleSupported || caps.bluetooth === 'unsupported') {
    return 'unsupported';
  }
  if (caps.permission !== 'granted' || caps.bluetooth === 'unauthorized') {
    const canAsk =
      caps.permission === 'undetermined' || (caps.permission === 'denied' && caps.canAskAgain);
    return options.afterRequest !== true && canAsk ? 'btExplain' : 'btDenied';
  }
  if (caps.bluetooth === 'off') return 'btOff';
  // P6: quem não anuncia não encosta (o encosto exige os dois anunciando).
  if (!caps.canAdvertise) return 'unsupported';
  // Android ≤ 11 com a localização do sistema desligada: a varredura volta vazia (estado 4b).
  if (caps.locationServices === 'off') return 'btLocationOff';
  return 'ready';
}

/** Erro do módulo nativo → estado de Bluetooth. */
function radioFailure(error: unknown): 'btOff' | 'btDenied' | 'unsupported' {
  const code = nativeErrorCode(error);
  if (code === 'ERR_BLUETOOTH_UNAVAILABLE') return 'btOff';
  if (code === 'ERR_BLUETOOTH_PERMISSION') return 'btDenied';
  return 'unsupported';
}

/** Só a potência do Android: o anúncio nunca leva o campo TX Power (ADR 0012, adendo A1). */
const ADVERTISE: AdvertiseOptions = { txPower: TOUCH_CALIBRATION.android.advertiseTxPower };

const PLATFORM: TouchReceiver['platform'] = Platform.OS === 'android' ? 'android' : 'ios';

export interface UseConnectSessionOptions {
  /** O app está em primeiro plano (em background, tudo pausa e recomeça ao voltar). */
  live: boolean;
  /** Token do deep link `sussurro://c/{qrToken}` (parâmetro `qr` da rota), ou `null`. */
  qrParam: string | null;
  /** O deep link já foi tratado (a rota guarda, para a tela não tratar duas vezes). */
  isQrHandled: (token: string) => boolean;
  onQrHandled: (token: string) => void;
}

/**
 * A tela Conectar inteira (ux.md §11.4): os dois tokens renovados, o anúncio e a varredura BLE, o
 * "encostar" (`useTouch`), o cartão de quem encostou, o pedido e o "Aguardando", o pedido recebido
 * (no cartão ou na folha), o QR cruzado (D7) e os estados de erro. Montada só com a aba em foco:
 * sair da aba desmonta tudo (anúncio e varredura param, PROX-28) e a volta começa no Verificando.
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
  const radio = useProximityRadio();
  const toast = useToast();
  const posts = usePostStore();
  const [state, dispatch] = useReducer(reducer, user.emailVerified, (verified): SessionState => ({
    mode: 'touch',
    view: CHECKING,
    halt: verified ? null : 'emailNotVerified',
    busy: null,
    unsupported: false,
    ready: { reason: 'open', run: 0 },
  }));
  /** Pedidos simulados em dev (por QR): o `qrToken` da persona para o aceite. */
  const [simulated, setSimulated] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [sheetError, setSheetError] = useState<{ id: string; message: string } | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [scanner, setScanner] = useState<ScannerState | null>(null);
  const [deviceModel, setDeviceModel] = useState('');
  const block = useBlockAccount();
  /**
   * Bloquear e denunciar pelo cartão (§11.14). O `ref` é a fonte da verdade (as decisões no mesmo
   * evento leem o valor novo); o estado só redesenha a tela.
   */
  const moderationRef = useRef<CardModeration>(NO_MODERATION);
  const [moderation, setModeration] = useState<CardModeration>(NO_MODERATION);
  const patchModeration = useCallback((cardId: string, patch: Partial<CardModeration>) => {
    const previous = moderationRef.current;
    const base = previous.cardId === cardId ? previous : { ...NO_MODERATION, cardId };
    const next = { ...base, ...patch };
    moderationRef.current = next;
    setModeration(next);
  }, []);
  /** O estado do cartão `cardId` (o de outro cartão não vale). */
  const moderationOf = useCallback((cardId: string): CardModeration => {
    const current = moderationRef.current;
    return current.cardId === cardId ? current : { ...NO_MODERATION, cardId };
  }, []);

  const active = live && state.halt === null;
  const viewRef = useRef(state.view);
  const busyRef = useRef(state.busy);
  useEffect(() => {
    viewRef.current = state.view;
    busyRef.current = state.busy;
  });

  /** Erro que para a tela (429, Redis fora, sem rede, e-mail): `true` se parou. */
  const halt = useCallback((error: unknown): boolean => {
    const reason = haltReasonFor(error);
    if (reason === null) return false;
    dispatch({ type: 'halt', reason });
    setScanner(null);
    return true;
  }, []);

  const { tokens, refresh: refreshOwnTokens } = useProximityToken(api, active, (error) => {
    if (!halt(error)) dispatch({ type: 'halt', reason: 'unavailable' });
  });
  const bleToken = tokens?.bleToken ?? null;
  const tokensReady = tokens !== null;

  /** Repete uma vez depois de renovar os tokens se o servidor disse "tela fechada" (409). */
  const withScreenOpen = useCallback(
    async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        if (!isApiError(error, 'PROXIMITY_SCREEN_CLOSED')) throw error;
        await refreshOwnTokens();
        return call();
      }
    },
    [refreshOwnTokens],
  );

  // --- Pedido recebido: polling e a folha ou o cartão -------------------------------------------

  const incoming = useIncoming(api, active, (entry, expired) => {
    const first = firstName(entry.request.other.name);
    const message = expired ? COPY.expired(first) : COPY.gone(first);
    // O cartão que tinha virado este pedido fecha junto (o prazo do pedido acabou). O foco vai ao
    // título do Pronto, e o Toast anuncia depois do foco (ux.md §11.8).
    const view = viewRef.current;
    if (view.kind === 'card' && view.card.person.handle === entry.request.other.handle) {
      const cardId = cardIdOf(view.card);
      // Com o `Alert`, o formulário ou o bloqueio em andamento, o aviso espera (M15).
      if (isHeld(moderationOf(cardId))) {
        patchModeration(cardId, { heldGone: { message, request: entry.request } });
        return;
      }
      dispatch({ type: 'view', view: READY, reason: 'cardClosed' });
      toast.show({ message, announceAfterMs: announceAfterFocusMs() });
    } else {
      toast.show({ message });
    }
  });
  const head = incoming.head;
  const cardView = state.view.kind === 'card' ? state.view : null;
  const cardId = cardView === null ? null : cardIdOf(cardView.card);
  /** O estado de bloquear e denunciar do cartão na tela (`null` sem cartão). */
  const cardModeration = cardId !== null && moderation.cardId === cardId ? moderation : null;
  const cardHeld = cardModeration !== null && isHeld(cardModeration);
  /** O `Alert` ou o formulário por cima do cartão: o foco e o vencimento esperam (M15, M16). */
  const cardCovered =
    cardModeration !== null && (cardModeration.alertOpen || cardModeration.form !== 'closed');
  const formOpen = moderation.form !== 'closed';
  /** O pedido de quem está no cartão vira o próprio cartão (estado 14), sem a folha. */
  const liveCardIncoming =
    cardView !== null &&
    head !== null &&
    head.request.method === 'ble' &&
    head.request.other.handle === cardView.card.person.handle
      ? head
      : null;
  /**
   * O pedido do cartão (estado 14). O que sumiu com o cartão segurado continua desenhado até o
   * `Alert`, o formulário ou o bloqueio terminar (M15).
   */
  const cardRequest =
    liveCardIncoming?.request ?? (cardHeld ? (cardModeration.heldGone?.request ?? null) : null);
  const cardIncomingRef = useRef(liveCardIncoming);
  useEffect(() => {
    cardIncomingRef.current = liveCardIncoming;
  });

  // Pedido recebido (folha ou cartão): vibração leve e o anúncio A5 (D-UX24, ux.md §11.8). O foco
  // vai ao título do pedido; o A5 sai depois dele, em fila. Com o `Alert`, o formulário ou o
  // bloqueio em andamento, os dois esperam (M16); com o formulário aberto, a folha também.
  const cueHeld = formOpen || (liveCardIncoming !== null && cardHeld);
  const cueId = head === null || cueHeld ? null : head.request.id;
  const headName = head?.request.other.name ?? null;
  const cuedRef = useRef<string | null>(null);
  useEffect(() => {
    if (cueId === null || headName === null || cuedRef.current === cueId) return undefined;
    cuedRef.current = cueId;
    vibrate('incoming');
    return announceAfterFocus(COPY.announceIncoming(firstName(headName)));
  }, [cueId, headName]);

  // --- Capacidades do Bluetooth -------------------------------------------------------------------

  const applyCapabilities = useCallback(
    (caps: ProximityCapabilities, options: { afterRequest?: boolean } = {}) => {
      setDeviceModel(caps.deviceModel);
      const next = capabilityView(caps, options);
      // "Continuar" da explicação some da tela: o foco vai ao título do Pronto.
      const reason = options.afterRequest === true ? 'bluetooth' : undefined;
      if (next === 'unsupported') dispatch({ type: 'unsupported' });
      else if (next === 'ready') dispatch({ type: 'view', view: READY, reason });
      else dispatch({ type: 'view', view: { kind: next }, reason });
    },
    [],
  );

  // Verificando (1): a permissão, o Bluetooth e os próprios tokens. Sem pedir nada ao sistema: com
  // a permissão já dada, a tela fica pronta sozinha (D-UX21, P7); sem ela, primeiro a explicação.
  const checking = active && state.mode === 'touch' && state.view.kind === 'checking';
  useEffect(() => {
    if (!checking || !tokensReady) return undefined;
    let cancelled = false;
    radio
      .getCapabilities()
      .then((caps) => {
        if (!cancelled) applyCapabilities(caps);
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: 'unsupported' });
      });
    return () => {
      cancelled = true;
    };
  }, [applyCapabilities, checking, radio, tokensReady]);

  /** Falha do rádio no Encostar: o estado de Bluetooth certo (ou o QR, se não dá para encostar). */
  const failRadio = useCallback((error: unknown) => {
    if (!SCANNING_VIEWS.has(viewRef.current.kind)) return;
    const next = radioFailure(error);
    if (next === 'unsupported') dispatch({ type: 'unsupported' });
    else dispatch({ type: 'view', view: { kind: next } });
  }, []);

  /** "Continuar" na explicação: agora sim o pedido do sistema. */
  const requestBluetooth = useCallback(async () => {
    try {
      applyCapabilities(await radio.requestPermission(), { afterRequest: true });
    } catch {
      dispatch({ type: 'unsupported' });
    }
  }, [applyCapabilities, radio]);

  const openSettings = useCallback(() => {
    Linking.openSettings().catch(() => undefined);
  }, []);

  /** Android: "Ligar Bluetooth" (pedido do sistema; sem ele, os Ajustes do Bluetooth). */
  const turnOnBluetooth = useCallback(async () => {
    const asked = await radio.requestEnableBluetooth().catch(() => false);
    if (!asked) {
      Linking.sendIntent('android.settings.BLUETOOTH_SETTINGS').catch(() => {
        Linking.openSettings().catch(() => undefined);
      });
    }
  }, [radio]);

  // Bluetooth ligado/desligado pelo sistema; anúncio sem suporte descoberto só ao tentar.
  useEffect(() => {
    const stateSubscription = radio.onStateChange((bluetooth) => {
      const kind = viewRef.current.kind;
      if (bluetooth === 'off' && SCANNING_VIEWS.has(kind)) {
        dispatch({ type: 'view', view: { kind: 'btOff' } });
      } else if (bluetooth === 'on' && kind === 'btOff') {
        dispatch({ type: 'view', view: CHECKING, reason: 'bluetooth' });
      }
    });
    const errorSubscription = radio.onError((error) => {
      if (
        error.operation === 'advertise' &&
        error.code === 'unsupported' &&
        SCANNING_VIEWS.has(viewRef.current.kind)
      ) {
        dispatch({ type: 'unsupported' });
      }
    });
    return () => {
      stateSubscription.remove();
      errorSubscription.remove();
    };
  }, [radio]);

  // Voltou dos Ajustes: confere de novo a permissão, o Bluetooth e a localização.
  const wasLive = useRef(live);
  useEffect(() => {
    const returned = live && !wasLive.current;
    wasLive.current = live;
    const kind = viewRef.current.kind;
    if (returned && (kind === 'btDenied' || kind === 'btOff' || kind === 'btLocationOff')) {
      dispatch({ type: 'view', view: CHECKING, reason: 'bluetooth' });
    }
  }, [live]);

  // --- Anúncio, varredura e o encostar ------------------------------------------------------------

  const touchMode = active && state.mode === 'touch';
  // O anúncio só no Pronto: o cartão, o pedido e o QR não precisam dele (o pedido nasce do par).
  const advertising = touchMode && state.view.kind === 'ready' && bleToken !== null;
  useEffect(() => {
    if (!advertising) return undefined;
    return () => {
      radio.stopAdvertising().catch(() => undefined);
    };
  }, [advertising, radio]);
  useEffect(() => {
    // Token novo: o nativo troca o anúncio sem parar antes (sem buraco no anúncio).
    if (!advertising) return;
    radio.startAdvertising(bleToken, ADVERTISE).catch(failRadio);
  }, [advertising, bleToken, failRadio, radio]);

  const showCard = useCallback((card: TouchCard) => {
    dispatch({
      type: 'view',
      view: { kind: 'card', card, alreadyConnected: card.person.alreadyConnected },
    });
    // O "pode afastar": a vibração do cartão, nunca no Confirmando (D-UX24). O anúncio vem abaixo.
    vibrate('touched');
  }, []);

  const receiver = useMemo<TouchReceiver>(
    () => ({ platform: PLATFORM, model: deviceModel }),
    [deviceModel],
  );
  const listening = touchMode && state.view.kind === 'ready';
  const touch = useTouch({
    api,
    radio,
    scanning: touchMode && SCANNING_VIEWS.has(state.view.kind),
    listening,
    receiver,
    onCard: showCard,
    onReportError: (error) => {
      // 429, 503, 403, sem rede: para a tela. 400 (bug do app): o relato só para.
      halt(error);
    },
    onScanError: failRadio,
    refreshScreen: refreshOwnTokens,
  });

  // Leitor de tela nas fases do Pronto (A1, A2, T11, A6; ux.md §11.8).
  const announced = useRef({ phase: touch.phase, approachingAt: -Infinity, noTouch: false });
  useEffect(() => {
    const memory = announced.current;
    const previous = memory.phase;
    memory.phase = touch.phase;
    if (!listening || previous === touch.phase) return;
    const now = connectClock.now();
    switch (touch.phase) {
      case 'approaching':
        if (now - memory.approachingAt >= connectTiming.announceApproachingEveryMs) {
          memory.approachingAt = now;
          announce(COPY.announceApproaching);
        }
        break;
      case 'confirming':
        announce(COPY.announceConfirming);
        break;
      case 'notConfirmed':
        announce(COPY.touchFailed);
        break;
      case 'noTouch':
        if (!memory.noTouch) {
          memory.noTouch = true;
          announce(COPY.announceNoTouch);
        }
        break;
      case 'idle':
        break;
    }
  }, [listening, touch.phase]);

  // Tela acesa (ux.md §11.4): no Pronto, só nos primeiros 2 min sem encostar; sempre no
  // Confirmando, no Encostado (menos o de quem já é conexão, estado 12, que não tem prazo) e no
  // Aguardando.
  const cardWithDeadline = state.view.kind === 'card' && !state.view.alreadyConnected;
  const keepAwake =
    active && ((listening && touch.keepAwake) || cardWithDeadline || state.view.kind === 'waiting');
  useEffect(() => {
    if (!keepAwake) return undefined;
    radio.setKeepScreenOn(true).catch(() => undefined);
    return () => {
      radio.setKeepScreenOn(false).catch(() => undefined);
    };
  }, [keepAwake, radio]);

  // --- Cartão de quem encostou (estados 11, 12, 14 e 17) ------------------------------------------

  /**
   * O cartão venceu (17): volta ao Pronto, com o foco no título, e o Toast T20. O próprio Toast
   * anuncia, depois do foco e em fila (ux.md §11.4 e §11.8). O Bloqueado vence sem Toast: o T20
   * diria "encostem os celulares de novo" a quem acabou de bloquear (M13).
   */
  const expireCard = useCallback(
    (person: NearbyPerson) => {
      const view = viewRef.current;
      if (view.kind !== 'card' || view.card.person.handle !== person.handle) return;
      dispatch({ type: 'view', view: READY, reason: 'cardClosed' });
      if (moderationOf(cardIdOf(view.card)).blocked) return;
      toast.show({
        message: COPY.cardExpired(firstName(person.name)),
        announceAfterMs: announceAfterFocusMs(),
      });
    },
    [moderationOf, toast],
  );

  // A3 e A4 (ux.md §11.8): o foco vai ao nome no cartão, e o anúncio sai depois dele, em fila. O
  // 409 `ALREADY_CONNECTED` no Conectar troca o A3 pelo A4 (estado 12).
  const cardBlocked = cardModeration?.blocked === true;
  let cardAnnouncement: string | null = null;
  if (cardView !== null && cardRequest === null && !cardBlocked) {
    const { name } = cardView.card.person;
    cardAnnouncement = cardView.alreadyConnected
      ? COPY.announceTouchedConnected(name)
      : COPY.announceTouched(name);
  }
  useEffect(() => {
    if (cardAnnouncement === null) return undefined;
    return announceAfterFocus(cardAnnouncement);
  }, [cardAnnouncement]);

  /** O 14 chegou ao prazo do cartão: a linha some, e o pedido continua (M14). */
  const closeLine = useCallback(
    (id: string) => {
      const current = moderationOf(id);
      // O foco só vai ao título se estava na linha (o que o app sabe: o `Alert` cancelado ou o erro
      // do bloqueio deixaram o foco no ‹Bloquear›).
      patchModeration(id, {
        lineGone: true,
        focusOnLine: false,
        focusRun: current.focusOnLine ? current.focusRun + 1 : current.focusRun,
      });
    },
    [moderationOf, patchModeration],
  );

  // O cartão vale até o `expiresAt` (P4, PROX-64); o de quem já é conexão (estado 12) não tem prazo.
  // No 14, o prazo do cartão só tira a linha (o pedido segue o prazo dele, 120 s). Com o `Alert`, o
  // formulário ou o bloqueio em andamento, o vencimento espera (M15).
  const cardIsRequest = cardRequest !== null;
  const lineGone = cardModeration?.lineGone === true;
  useEffect(() => {
    if (cardView === null || cardView.alreadyConnected || cardHeld) return undefined;
    if (cardIsRequest && lineGone) return undefined;
    const timer = setTimeout(
      () => {
        if (cardIsRequest) closeLine(cardIdOf(cardView.card));
        else expireCard(cardView.card.person);
      },
      Math.max(0, cardView.card.expiresAt - connectClock.now()),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [cardHeld, cardIsRequest, cardView, closeLine, expireCard, lineGone]);

  /**
   * Fecha o que segurava o cartão (o `Alert`, o bloqueio ou o formulário) e aplica o que a §11.14
   * manda para cada variante (M2, M6, M7, M9, M10, M12, M15): volta ao cartão, tira a linha do 14
   * ou volta ao Pronto, com o Toast certo. O foco vai ao cabeçalho do cartão quando o controle
   * focado some (o formulário fechou, ou o ‹Bloquear› saiu com a linha).
   */
  const settleCard = useCallback(
    (id: string, outcome: CardOutcome) => {
      const view = viewRef.current;
      const current = moderationOf(id);
      const toasts: { message: string; variant?: 'success' | 'error' }[] = [];
      if (outcome.kind === 'sent')
        toasts.push({ message: REPORT_SENT_MESSAGE, variant: 'success' });
      if (outcome.kind === 'gone') toasts.push({ message: PROFILE_GONE_MESSAGE, variant: 'error' });
      const onCard = view.kind === 'card' && cardIdOf(view.card) === id;
      if (!onCard) {
        // O cartão já saiu da tela por outro motivo (a tela parou): só o aviso do que aconteceu.
        patchModeration(id, { heldGone: null });
        for (const options of toasts) toast.show(options);
        return;
      }
      const requestPending = current.heldGone === null && cardIncomingRef.current !== null;
      const expired = !view.alreadyConnected && connectClock.now() >= view.card.expiresAt;
      let close = false;
      let removeLine = false;
      if (current.heldGone !== null) {
        // O pedido do cartão venceu ou sumiu enquanto o cartão estava segurado.
        close = true;
        toasts.push({ message: current.heldGone.message });
      } else if (outcome.kind === 'gone') {
        // 404 (o par acabou no servidor) ou "Bloquear" depois do prazo: o 14 fica como pedido.
        if (requestPending) removeLine = true;
        else close = true;
      } else if (expired) {
        if (requestPending) {
          removeLine = true;
        } else {
          close = true;
          // O 17 de sempre, sem o T20 depois de enviar e no Bloqueado (M9, M12, M13).
          if (outcome.kind !== 'sent' && !current.blocked) {
            toasts.push({ message: COPY.cardExpired(firstName(view.card.person.name)) });
          }
        }
      }
      const fromForm =
        outcome.kind === 'sent' ||
        outcome.kind === 'formCancelled' ||
        (outcome.kind === 'gone' && outcome.from === 'form');
      const lineVanished = removeLine && !current.lineGone;
      const moveFocus = close || fromForm || lineVanished;
      if (close) {
        dispatch({ type: 'view', view: READY, reason: 'cardClosed' });
        patchModeration(id, { heldGone: null });
      } else {
        patchModeration(id, {
          heldGone: null,
          lineGone: current.lineGone || removeLine,
          focusRun: moveFocus ? current.focusRun + 1 : current.focusRun,
          focusOnLine: moveFocus ? false : current.focusOnLine,
        });
      }
      for (const options of toasts) {
        toast.show(moveFocus ? { ...options, announceAfterMs: announceAfterFocusMs() } : options);
      }
    },
    [moderationOf, patchModeration, toast],
  );

  // --- Pedido (A) ---------------------------------------------------------------------------------

  const markConnected = useCallback(
    (other: ConnectionRequestParty) => {
      dispatch({ type: 'view', view: { kind: 'connected', other, at: connectClock.now() } });
      posts.showPostsOf(other.handle);
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

  /** "Conectar com Caio" no cartão: o pedido com o `bleToken` devolvido no casamento. */
  const connectCard = useCallback(async () => {
    const view = viewRef.current;
    if (view.kind !== 'card' || busyRef.current !== null) return;
    // Bloqueando, ou já bloqueado: o pedido seria recusado (M3, M4).
    const current = moderationOf(cardIdOf(view.card));
    if (current.blocking || current.blocked) return;
    const { person, expiresAt } = view.card;
    if (connectClock.now() >= expiresAt) {
      expireCard(person);
      return;
    }
    dispatch({ type: 'busy', value: person.handle });
    try {
      afterCreated(await withScreenOpen(() => createConnectionRequest(api, person.token, 'ble')));
    } catch (error) {
      if (isApiError(error, 'ALREADY_CONNECTED')) {
        // Estado 12, sem Toast: o foco vai de novo ao nome, com o A4 depois (efeito acima).
        dispatch({ type: 'view', view: { ...view, alreadyConnected: true } });
      } else if (isApiError(error, 'PROXIMITY_TOKEN_INVALID')) {
        // O par venceu no servidor: o mesmo "o cartão venceu" (17), sem revelar o motivo.
        expireCard(person);
      } else if (error instanceof NetworkError) {
        toast.show({ message: OFFLINE_MESSAGE, variant: 'error' });
      } else if (!halt(error)) {
        toast.show({ message: messageForError(error), variant: 'error' });
      }
    } finally {
      dispatch({ type: 'busy', value: null });
    }
  }, [afterCreated, api, expireCard, halt, moderationOf, toast, withScreenOpen]);

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

  /**
   * O início do modo atual: o Pronto no Encostar; o meu código no QR. O botão tocado some da tela:
   * no Pronto, o foco vai ao título.
   */
  const backToStart = useCallback(() => {
    dispatch({ type: 'view', view: state.mode === 'touch' ? READY : CHECKING, reason: 'restart' });
  }, [state.mode]);

  const cancelRequest = useCallback(async () => {
    const view = viewRef.current;
    if (view.kind !== 'waiting') return;
    dispatch({ type: 'busy', value: 'cancel' });
    try {
      const result = await cancelConnectionRequest(api, view.request.id);
      // B pode ter aceitado um instante antes: aí já são conexão.
      if (result.status === 'accepted') markConnected(result.other);
      else backToStart();
    } catch (error) {
      if (isApiError(error, 'NOT_FOUND')) backToStart();
      else toast.show({ message: messageForError(error), variant: 'error' });
    } finally {
      dispatch({ type: 'busy', value: null });
    }
  }, [api, backToStart, markConnected, toast]);

  // --- Pedido recebido (B) -------------------------------------------------------------------------

  const acceptWith = useCallback(
    async (request: ConnectionRequest, observedToken?: string) => {
      const first = firstName(request.other.name);
      setSheetBusy(true);
      try {
        const result = await withScreenOpen(() =>
          acceptConnectionRequest(api, request.id, observedToken),
        );
        incoming.dismiss(request.id);
        if (result.status === 'accepted') markConnected(result.other);
        else toast.show({ message: COPY.expired(first) });
      } catch (error) {
        const fail = (message: string) => {
          setSheetError({ id: request.id, message });
        };
        if (isApiError(error, 'REQUEST_EXPIRED')) {
          incoming.dismiss(request.id);
          toast.show({ message: COPY.expired(first) });
        } else if (isApiError(error, 'NOT_FOUND')) {
          incoming.dismiss(request.id);
          toast.show({ message: COPY.gone(first) });
        } else if (isApiError(error, 'PROXIMITY_TOKEN_INVALID')) {
          fail(request.method === 'ble' ? COPY.notSeen(first) : COPY.acceptFailed(first));
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

  /**
   * "Aceitar": por encostar (`ble`), sem token (o par já provou o encontro, ADR 0012 §4); por QR, a
   * câmera lê o código de quem pediu (D7). Na simulação de um pedido por QR, o `qrToken` devolvido
   * pela rota de dev faz as vezes da leitura.
   */
  const acceptHead = useCallback(async () => {
    // O pedido no cartão segurado (bloqueio em andamento, M3): Aceitar fica desativado.
    if (head === null || sheetBusy || (liveCardIncoming !== null && cardHeld)) return;
    const { request } = head;
    if (request.method === 'ble') {
      await acceptWith(request);
      return;
    }
    const simulatedToken = simulated.get(request.id);
    if (simulatedToken === undefined) {
      setScanner({ purpose: { kind: 'accept', request }, error: null, busy: false });
      return;
    }
    await acceptWith(request, simulatedToken);
  }, [acceptWith, cardHeld, head, liveCardIncoming, sheetBusy, simulated]);

  /** "Recusar": a folha (ou o cartão) fecha na hora. Quem pediu só vê "não confirmou". */
  const declineHead = useCallback(async () => {
    if (head === null || (liveCardIncoming !== null && cardHeld)) return;
    const { request } = head;
    incoming.dismiss(request.id);
    const view = viewRef.current;
    if (view.kind === 'card' && view.card.person.handle === request.other.handle) {
      dispatch({ type: 'view', view: READY, reason: 'cardClosed' });
    }
    try {
      await declineConnectionRequest(api, request.id);
    } catch (error) {
      if (!isApiError(error, 'NOT_FOUND')) {
        toast.show({ message: messageForError(error), variant: 'error' });
      }
    }
  }, [api, cardHeld, head, incoming, liveCardIncoming, toast]);

  // --- Bloquear e denunciar pelo cartão (ux.md §11.14; ADR 0012, A2 rev. 1, R1-5) ----------------

  /**
   * ‹Bloquear› no cartão: o `Alert` do perfil, com os mesmos textos e os mesmos efeitos depois do
   * 204 (M1 a M7). Os erros (503, 429, sem rede) mostram o Toast e deixam o cartão igual: nunca
   * param a tela (estados 18 a 20).
   */
  const blockCard = useCallback(() => {
    const view = viewRef.current;
    if (view.kind !== 'card' || busyRef.current !== null) return;
    const { card, alreadyConnected } = view;
    const id = cardIdOf(card);
    const current = moderationOf(id);
    if (current.blocked || isHeld(current)) return;
    const { handle } = card.person;
    patchModeration(id, { handle, alertOpen: true, focusOnLine: false });
    block(
      { handle },
      {
        successToast: false,
        onCancel: () => {
          if (!moderationOf(id).alertOpen) return;
          // M2: nada muda; o sistema devolve o foco ao ‹Bloquear›.
          patchModeration(id, { alertOpen: false, focusOnLine: true });
          settleCard(id, { kind: 'alertCancelled' });
        },
        onConfirm: () => {
          patchModeration(id, { alertOpen: false });
          // M7: o `Alert` segurou o cartão além do prazo, ou a confirmação saiu nos últimos 3 s
          // dele (R1-11). Fora do par, o 204 não grava, e o app diria "Você bloqueou" sem ter
          // bloqueado: não chama a API. O 12 não tem prazo.
          const deadline = card.expiresAt - connectTiming.blockConfirmMarginMs;
          if (!alreadyConnected && connectClock.now() >= deadline) {
            settleCard(id, { kind: 'gone', from: 'alert' });
            return false;
          }
          patchModeration(id, { blocking: true });
          return true;
        },
        onBlocked: () => {
          // O servidor cancelou o pedido pendente do par: sai sem o Toast "não está mais disponível".
          const pending = incoming.findFrom(handle);
          if (pending !== null) incoming.dismiss(pending.request.id);
          const now = viewRef.current;
          const onCard = now.kind === 'card' && cardIdOf(now.card) === id;
          if (onCard && !alreadyConnected && connectClock.now() < card.expiresAt) {
            // M4: o cartão vira o Bloqueado, sem Toast; o foco vai ao nome e o anúncio sai depois.
            patchModeration(id, {
              blocking: false,
              blocked: true,
              heldGone: null,
              focusOnLine: false,
            });
            announceAfterFocus(blockedMessage(handle));
            return;
          }
          // M5 (12), ou o cartão que venceu durante a chamada: fecha, como o perfil depois do
          // bloqueio, com o Toast `blockedMessage` depois do foco no título do Pronto.
          patchModeration(id, { blocking: false, heldGone: null });
          if (onCard) dispatch({ type: 'view', view: READY, reason: 'cardClosed' });
          toast.show({
            message: blockedMessage(handle),
            variant: 'success',
            ...(onCard ? { announceAfterMs: announceAfterFocusMs() } : {}),
          });
        },
        onFailed: () => {
          // M6: o Toast do erro já saiu; o cartão fica como estava e o foco, no ‹Bloquear›.
          patchModeration(id, { blocking: false, focusOnLine: true });
          settleCard(id, { kind: 'blockFailed' });
        },
      },
    );
  }, [block, incoming, moderationOf, patchModeration, settleCard, toast]);

  /** ‹Denunciar› no cartão: o formulário por cima do cartão, que continua montado (M8). */
  const openReport = useCallback(() => {
    const view = viewRef.current;
    if (view.kind !== 'card' || busyRef.current !== null) return;
    const id = cardIdOf(view.card);
    const current = moderationOf(id);
    if (isHeld(current)) return;
    patchModeration(id, {
      handle: view.card.person.handle,
      form: 'open',
      formRun: current.formRun + 1,
      formNote: !view.alreadyConnected,
      focusOnLine: false,
    });
  }, [moderationOf, patchModeration]);

  /** Como o formulário fechou, à espera do `onDismiss` do `Modal` no iOS. */
  const pendingFormClose = useRef<{ id: string; outcome: CardOutcome } | null>(null);
  const dismissFallback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * O `Modal` saiu: o foco, o Toast e a volta ao cartão ou ao Pronto. No iOS, só depois do
   * `onDismiss`; antes disso, o sistema devolve o foco a outro lugar e corta o anúncio (§11.13).
   */
  const finishFormClose = useCallback(() => {
    const pending = pendingFormClose.current;
    if (pending === null) return;
    pendingFormClose.current = null;
    clearTimeout(dismissFallback.current);
    patchModeration(pending.id, { form: 'closed' });
    settleCard(pending.id, pending.outcome);
  }, [patchModeration, settleCard]);

  const closeForm = useCallback(
    (outcome: CardOutcome) => {
      const current = moderationRef.current;
      if (current.form !== 'open') {
        // A resposta chegou depois do "Cancelar": a denúncia foi enviada mesmo assim.
        if (outcome.kind === 'sent') {
          toast.show({ message: REPORT_SENT_MESSAGE, variant: 'success' });
        }
        return;
      }
      pendingFormClose.current = { id: current.cardId, outcome };
      patchModeration(current.cardId, { form: 'closing' });
      if (Platform.OS !== 'ios') {
        finishFormClose();
        return;
      }
      clearTimeout(dismissFallback.current);
      dismissFallback.current = setTimeout(finishFormClose, connectTiming.formDismissFallbackMs);
    },
    [finishFormClose, patchModeration, toast],
  );

  // --- QR code (4.7, D7) ---------------------------------------------------------------------------

  const qrProblem = useCallback(
    (message: string, fromScanner: boolean) => {
      if (fromScanner) {
        setScanner((current) =>
          current === null ? null : { ...current, busy: false, error: message },
        );
      } else {
        toast.show({ message, variant: 'error' });
      }
    },
    [toast],
  );

  const failCreateByQr = useCallback(
    (error: unknown) => {
      if (isApiError(error, 'ALREADY_CONNECTED')) {
        toast.show({ message: COPY.alreadyConnected });
      } else if (isApiError(error, 'PROXIMITY_TOKEN_INVALID')) {
        toast.show({ message: COPY.cannotSend, variant: 'error' });
      } else if (error instanceof NetworkError) {
        toast.show({ message: OFFLINE_MESSAGE, variant: 'error' });
      } else if (!halt(error)) {
        toast.show({ message: messageForError(error), variant: 'error' });
      }
    },
    [halt, toast],
  );

  /**
   * Um `qrToken` lido de um QR (câmera do app ou deep link). Primeiro o `resolve` (não conta como
   * falha de token): QR vencido ou adulterado não cria nada (4.7 CA4). Depois: no aceite, confere
   * que o código é de quem pediu; senão, se a pessoa já me pediu, aceita; se não, pede (`qr`).
   */
  const handleQrToken = useCallback(
    async (qrToken: string, purpose: ScannerPurpose, fromScanner: boolean) => {
      let person: NearbyPerson | undefined;
      try {
        person = (await withScreenOpen(() => resolveQrToken(api, qrToken))).items[0];
      } catch (error) {
        if (halt(error)) return;
        qrProblem(messageForError(error), fromScanner);
        return;
      }
      if (person === undefined) {
        qrProblem(COPY.qrInvalid, fromScanner);
        return;
      }
      if (purpose.kind === 'accept') {
        if (person.handle !== purpose.request.other.handle) {
          qrProblem(COPY.qrNotTheirs(firstName(purpose.request.other.name)), fromScanner);
          return;
        }
        setScanner(null);
        await acceptWith(purpose.request, person.token);
        return;
      }
      setScanner(null);
      const fromThem = incoming.findFrom(person.handle);
      if (fromThem !== null) {
        await acceptWith(
          fromThem.request,
          fromThem.request.method === 'qr' ? person.token : undefined,
        );
        return;
      }
      if (person.alreadyConnected) {
        toast.show({ message: COPY.alreadyConnected });
        return;
      }
      const target = person;
      dispatch({ type: 'busy', value: target.handle });
      try {
        afterCreated(await withScreenOpen(() => createConnectionRequest(api, target.token, 'qr')));
      } catch (error) {
        failCreateByQr(error);
      } finally {
        dispatch({ type: 'busy', value: null });
      }
    },
    [
      acceptWith,
      afterCreated,
      api,
      failCreateByQr,
      halt,
      incoming,
      qrProblem,
      toast,
      withScreenOpen,
    ],
  );

  const scannerRef = useRef(scanner);
  useEffect(() => {
    scannerRef.current = scanner;
  });

  /** Leitura da câmera: o conteúdo precisa ser `sussurro://c/{qrToken}` (senão, nada é enviado). */
  const onScanned = useCallback(
    async (data: string) => {
      const current = scannerRef.current;
      if (current === null || current.busy) return;
      const qrToken = parseProximityQr(data);
      if (qrToken === null) {
        if (current.error !== COPY.qrInvalid) setScanner({ ...current, error: COPY.qrInvalid });
        return;
      }
      const next = { ...current, busy: true, error: null };
      scannerRef.current = next;
      setScanner(next);
      await handleQrToken(qrToken, current.purpose, true);
    },
    [handleQrToken],
  );

  const openScanner = useCallback(() => {
    setScanner({ purpose: { kind: 'auto' }, error: null, busy: false });
  }, []);
  const closeScanner = useCallback(() => {
    setScanner(null);
  }, []);
  /** "Mostrar meu código" (câmera negada): a aba "QR code" com o meu QR. */
  const showMyCode = useCallback(() => {
    setScanner(null);
    dispatch({ type: 'mode', mode: 'qr' });
  }, []);

  // Deep link do QR (`sussurro://c/{qrToken}`): espera os meus tokens (tela aberta no servidor).
  const handleQrTokenRef = useRef(handleQrToken);
  const linkRef = useRef({ isQrHandled, onQrHandled });
  useEffect(() => {
    handleQrTokenRef.current = handleQrToken;
    linkRef.current = { isQrHandled, onQrHandled };
  });
  useEffect(() => {
    if (qrParam === null || !active || !tokensReady) return;
    if (linkRef.current.isQrHandled(qrParam)) return;
    linkRef.current.onQrHandled(qrParam);
    const qrToken = qrParam;
    void Promise.resolve().then(() => {
      dispatch({ type: 'mode', mode: 'qr' });
      if (ProximityTokenValueSchema.safeParse(qrToken).success) {
        void handleQrTokenRef.current(qrToken, { kind: 'auto' }, false);
      } else {
        toast.show({ message: COPY.qrInvalid, variant: 'error' });
      }
    });
  }, [active, qrParam, toast, tokensReady]);

  // --- Simulações e a calibração (só no build de desenvolvimento, D15) ----------------------------

  const simulationEnabled = isSimulationEnabled();
  const simulate = useCallback(async () => {
    try {
      const result = await simulateIncomingRequest(api);
      setSimulated((current) => new Map([...current, [result.request.id, result.observedToken]]));
      incoming.inject(result.request);
    } catch (error) {
      toast.show({ message: messageForError(error), variant: 'error' });
    }
  }, [api, incoming, toast]);

  /** "Simular o outro celular encostando": o app relata o `bleToken` da persona em `touches`. */
  const simulateTouchFromPersona = useCallback(async () => {
    try {
      const { bleToken: personaToken } = await simulateTouch(api);
      touch.simulate(personaToken);
    } catch (error) {
      toast.show({ message: messageForError(error), variant: 'error' });
    }
  }, [api, toast, touch]);

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

  // A folha espera o formulário de denúncia fechar (dois `Modal` um sobre o outro, não).
  const showSheet = head !== null && scanner === null && cardRequest === null && !formOpen;
  const incomingError =
    sheetError !== null && sheetError.id === head?.request.id ? sheetError.message : null;

  return {
    user,
    mode: state.mode,
    view: state.view,
    halt: state.halt,
    busy: state.busy,
    unsupported: state.unsupported,
    tokens,
    touch: { phase: touch.phase, demoRun: touch.demoRun },
    /** Foco no título do Pronto (ux.md §11.8): só quando o controle focado sumiu da tela. */
    readyFocus: {
      key: `pronto:${String(state.ready.run)}`,
      enabled: FOCUS_READY_TITLE.has(state.ready.reason),
    },
    /** O pedido de quem está no cartão (estado 14), mostrado no próprio cartão. */
    cardIncoming:
      cardRequest === null || cardBlocked
        ? null
        : {
            request: cardRequest,
            secondsLeft: liveCardIncoming === null ? 0 : incoming.secondsLeft,
            error: liveCardIncoming === null ? null : incomingError,
            busy: sheetBusy,
          },
    /** Bloquear e denunciar pelo cartão (ux.md §11.14), para o cartão na tela. */
    cardActions:
      cardView === null
        ? null
        : {
            blocked: cardBlocked,
            blocking: cardModeration?.blocking === true,
            /** No 14, a linha some no prazo do cartão (M14); no resto, fica até o cartão fechar. */
            lineVisible: !(cardRequest !== null && !cardBlocked && lineGone),
            focusRun: cardModeration?.focusRun ?? 0,
            /** O `Alert` ou o formulário por cima: o foco espera (M15, M16). */
            focusHeld: cardCovered,
          },
    /** O formulário de denúncia por cima do cartão (M8), enquanto aberto ou saindo. */
    reportForm:
      moderation.form === 'closed'
        ? null
        : {
            visible: moderation.form === 'open',
            run: moderation.formRun,
            handle: moderation.handle,
            /** O T46, só no formulário aberto pelo 11, pelo 14 ou pelo Bloqueado. */
            note: moderation.formNote ? COPY.reportDeadline : undefined,
          },
    /** A folha da §4.11: só quando o pedido não é de quem está no cartão. */
    incoming: showSheet
      ? {
          request: head.request,
          secondsLeft: incoming.secondsLeft,
          error: incomingError,
          busy: sheetBusy,
          acceptByQr: head.request.method === 'qr' && !simulated.has(head.request.id),
        }
      : null,
    scanner,
    simulationEnabled,
    actions: {
      setMode: (mode: ConnectMode) => {
        dispatch({ type: 'mode', mode });
      },
      requestBluetooth: () => {
        void requestBluetooth();
      },
      openSettings,
      turnOnBluetooth: () => {
        void turnOnBluetooth();
      },
      useQr: () => {
        dispatch({ type: 'mode', mode: 'qr' });
      },
      connectCard: () => {
        void connectCard();
      },
      /**
       * "Cancelar" (cartão) e "Voltar" (já conectados e Bloqueado, M13): de volta ao Pronto, com o
       * foco no título e sem Toast.
       */
      closeCard: () => {
        const view = viewRef.current;
        if (view.kind === 'card' && isHeld(moderationOf(cardIdOf(view.card)))) return;
        dispatch({ type: 'view', view: READY, reason: 'cardClosed' });
      },
      /** ‹Bloquear› no cartão (M1). */
      blockCard,
      /** ‹Denunciar› no cartão (M8). */
      reportCard: openReport,
      /** "Cancelar" ou o "voltar" do Android no formulário (M12). */
      cancelReport: () => {
        closeForm({ kind: 'formCancelled' });
      },
      /** 202 (M9). */
      reportSent: () => {
        closeForm({ kind: 'sent' });
      },
      /** 404: o par acabou no servidor, ou a conta foi excluída (M10). */
      reportGone: () => {
        closeForm({ kind: 'gone', from: 'form' });
      },
      /** O `Modal` do formulário saiu da tela (iOS). */
      reportDismissed: finishFormClose,
      cancelRequest: () => {
        void cancelRequest();
      },
      retryAfterNotConfirmed: backToStart,
      backToStart,
      accept: () => {
        void acceptHead();
      },
      decline: () => {
        void declineHead();
      },
      /** ✕ ou voltar na folha: fecha sem responder (o pedido segue até vencer). */
      closeSheet: () => {
        if (head !== null) incoming.dismiss(head.request.id);
      },
      openScanner,
      closeScanner,
      onScanned: (data: string) => {
        void onScanned(data);
      },
      showMyCode,
      simulate: () => {
        void simulate();
      },
      simulateTouch: () => {
        void simulateTouchFromPersona();
      },
      openCalibration: () => {
        router.push('/dev/proximidade');
      },
      resume: () => {
        void resume();
      },
    },
  };
}

export type ConnectSession = ReturnType<typeof useConnectSession>;
