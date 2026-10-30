import {
  type ConnectionRequest,
  type ConnectionRequestParty,
  type NearbyPerson,
  parseProximityQr,
  ProximityTokenValueSchema,
} from '@sussurro/shared';
import { useToast } from '@sussurro/ui';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { AccessibilityInfo, Linking } from 'react-native';

import {
  acceptConnectionRequest,
  cancelConnectionRequest,
  createConnectionRequest,
  declineConnectionRequest,
  fetchConnectionRequest,
  resolveTokens,
  simulateIncomingRequest,
} from './api';
import { COPY, firstName } from './copy';
import { isSimulationEnabled } from './dev-tools';
import { type HaltReason, haltReasonFor, nativeErrorCode } from './errors';
import { usePolling, useProximityToken } from './hooks';
import type { NearbyRow } from './nearby';
import { useProximityRadio } from './RadioProvider';
import { connectClock, connectTiming, RECENT_TTL_MS, TOKEN_TTL_MS } from './timing';
import { useIncoming } from './useIncoming';
import { useNearby } from './useNearby';
import type { ProximityCapabilities } from '../../../modules/sussurro-proximity';
import { ApiError, isApiError, NetworkError } from '../../lib/api/errors';
import { messageForError, OFFLINE_MESSAGE } from '../../lib/error-messages';
import { useAuth, useSignedInUser } from '../auth/AuthProvider';
import { useNotifications } from '../notifications/NotificationsProvider';
import { usePostStore } from '../posts/post-store';

export type ConnectMode = 'ble' | 'qr';

/** Estados da tela (ux.md §5.2). O "Inicial" é `start`, no modo do seletor. */
export type ConnectView =
  | { kind: 'start' }
  | { kind: 'btExplain' }
  | { kind: 'btDenied' }
  | { kind: 'btOff' }
  | { kind: 'btUnavailable' }
  | { kind: 'cannotAdvertise' }
  | { kind: 'searching'; startedAt: number; advertise: boolean }
  | { kind: 'waiting'; request: ConnectionRequest }
  | { kind: 'notConfirmed'; request: ConnectionRequest }
  | { kind: 'connected'; other: ConnectionRequestParty; at: number };

interface SessionState {
  mode: ConnectMode;
  view: ConnectView;
  halt: HaltReason | null;
  /** @ do pedido em envio, ou "cancel" (para o botão em carregamento). */
  busy: string | null;
}

type Action =
  | { type: 'mode'; mode: ConnectMode }
  | { type: 'view'; view: ConnectView }
  | { type: 'halt'; reason: HaltReason }
  | { type: 'resume' }
  | { type: 'busy'; value: string | null };

const START: ConnectView = { kind: 'start' };

function reducer(state: SessionState, action: Action): SessionState {
  switch (action.type) {
    case 'mode':
      return { ...state, mode: action.mode, view: START };
    case 'view':
      return { ...state, view: action.view };
    case 'halt':
      return { ...state, halt: action.reason, view: START, busy: null };
    case 'resume':
      return { ...state, halt: null, view: START };
    case 'busy':
      return { ...state, busy: action.value };
  }
}

/** Para que a câmera foi aberta: pedir (A lê o QR de B) ou aceitar (B lê o QR de A, D7). */
export type ScannerPurpose = { kind: 'auto' } | { kind: 'accept'; request: ConnectionRequest };

export interface ScannerState {
  purpose: ScannerPurpose;
  error: string | null;
  busy: boolean;
}

/** O que as capacidades do Bluetooth permitem agora (ux.md §4.12). */
export function capabilityView(
  caps: ProximityCapabilities,
  options: { afterRequest?: boolean; allowNoAdvertise?: boolean } = {},
): ConnectView | 'ready' {
  if (!caps.available || !caps.bleSupported || caps.bluetooth === 'unsupported') {
    return { kind: 'btUnavailable' };
  }
  if (caps.permission !== 'granted' || caps.bluetooth === 'unauthorized') {
    const canAsk =
      caps.permission === 'undetermined' || (caps.permission === 'denied' && caps.canAskAgain);
    return options.afterRequest !== true && canAsk ? { kind: 'btExplain' } : { kind: 'btDenied' };
  }
  if (caps.bluetooth === 'off') return { kind: 'btOff' };
  if (!caps.canAdvertise && options.allowNoAdvertise !== true) return { kind: 'cannotAdvertise' };
  return 'ready';
}

/** Erro do módulo nativo → estado de Bluetooth. */
function radioFailureView(error: unknown): ConnectView {
  const code = nativeErrorCode(error);
  if (code === 'ERR_BLUETOOTH_UNAVAILABLE') return { kind: 'btOff' };
  if (code === 'ERR_BLUETOOTH_PERMISSION') return { kind: 'btDenied' };
  if (code === 'ERR_ADVERTISING_UNSUPPORTED') return { kind: 'cannotAdvertise' };
  return { kind: 'btUnavailable' };
}

function announce(message: string) {
  AccessibilityInfo.announceForAccessibility(message);
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
 * A tela Conectar inteira (ux.md §5.2): o token renovado, o anúncio e a varredura BLE, "Por perto
 * agora", o pedido e o "Aguardando", a folha do pedido recebido, o QR cruzado (D7) e os estados de
 * erro. Montada só com a aba em foco: sair da aba desmonta tudo (anúncio e varredura param, PROX-28)
 * e a volta começa no Inicial.
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
    mode: 'ble',
    view: START,
    halt: verified ? null : 'emailNotVerified',
    busy: null,
  }));
  const [simulated, setSimulated] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [bleReady, setBleReady] = useState(false);
  const [sheetError, setSheetError] = useState<{ id: string; message: string } | null>(null);
  const [sheetBusy, setSheetBusy] = useState(false);
  const [scanner, setScanner] = useState<ScannerState | null>(null);

  const active = live && state.halt === null;
  const viewRef = useRef(state.view);
  useEffect(() => {
    viewRef.current = state.view;
  });

  /** Erro que para a tela (429, Redis fora, sem rede, e-mail): `true` se parou. */
  const halt = useCallback((error: unknown): boolean => {
    const reason = haltReasonFor(error);
    if (reason === null) return false;
    dispatch({ type: 'halt', reason });
    setScanner(null);
    return true;
  }, []);

  const { token: ownToken, refresh: refreshOwnToken } = useProximityToken(api, active, (error) => {
    if (!halt(error)) dispatch({ type: 'halt', reason: 'unavailable' });
  });

  /** Repete uma vez depois de renovar o token se o servidor disse "tela fechada" (409). */
  const withScreenOpen = useCallback(
    async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        if (!isApiError(error, 'PROXIMITY_SCREEN_CLOSED')) throw error;
        await refreshOwnToken();
        return call();
      }
    },
    [refreshOwnToken],
  );

  const incoming = useIncoming(api, active, (entry, expired) => {
    const first = firstName(entry.request.other.name);
    toast.show({ message: expired ? COPY.expired(first) : COPY.gone(first) });
  });
  const head = incoming.head;
  const headIsBle =
    head !== null && head.request.method === 'ble' && !simulated.has(head.request.id);

  const searching = state.view.kind === 'searching';
  // Falha do rádio só muda a busca: no "Aguardando", o pedido já existe e segue valendo.
  const failRadio = useCallback((error: unknown) => {
    if (viewRef.current.kind === 'searching') {
      dispatch({ type: 'view', view: radioFailureView(error) });
    }
  }, []);

  const nearby = useNearby({
    api,
    radio,
    scanning: active && (searching || (headIsBle && bleReady)),
    hasOwnToken: ownToken !== null,
    onError: (error) => {
      if (isApiError(error, 'PROXIMITY_SCREEN_CLOSED')) {
        refreshOwnToken().catch((refreshError: unknown) => {
          halt(refreshError);
        });
        return;
      }
      // Erro da API (429, Redis fora, sem rede) para a tela; o resto veio do rádio.
      if (error instanceof ApiError || error instanceof NetworkError) halt(error);
      else failRadio(error);
    },
  });

  // Folha de um pedido por Bluetooth com a busca parada: confere se dá para varrer (sem pedir
  // permissão: só varre se já estava liberado) para observar o token de quem pediu (PROX-26).
  useEffect(() => {
    if (!active || !headIsBle || bleReady) return undefined;
    let cancelled = false;
    radio
      .getCapabilities()
      .then((caps) => {
        if (!cancelled && capabilityView(caps, { allowNoAdvertise: true }) === 'ready') {
          setBleReady(true);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [active, bleReady, headIsBle, radio]);

  // Anúncio: procurando, e no "Aguardando" por Bluetooth (B continua vendo o token novo de A).
  const advertising =
    active &&
    ownToken !== null &&
    ((state.view.kind === 'searching' && state.view.advertise) ||
      (state.view.kind === 'waiting' && state.view.request.method === 'ble'));
  useEffect(() => {
    if (!advertising) return undefined;
    return () => {
      radio.stopAdvertising().catch(() => undefined);
    };
  }, [advertising, radio]);
  useEffect(() => {
    // Token novo: o nativo troca o anúncio sem parar antes (sem buraco no anúncio).
    if (!advertising) return;
    radio.startAdvertising(ownToken).catch(failRadio);
  }, [advertising, failRadio, ownToken, radio]);

  // Tela acesa procurando ou aguardando (ux.md §5.2).
  const keepAwake = active && (searching || state.view.kind === 'waiting');
  useEffect(() => {
    if (!keepAwake) return undefined;
    radio.setKeepScreenOn(true).catch(() => undefined);
    return () => {
      radio.setKeepScreenOn(false).catch(() => undefined);
    };
  }, [keepAwake, radio]);

  // --- Busca por Bluetooth ------------------------------------------------------------------------

  const beginSearch = useCallback(
    (advertise: boolean) => {
      nearby.reset();
      setBleReady(true);
      dispatch({
        type: 'view',
        view: { kind: 'searching', startedAt: connectClock.now(), advertise },
      });
    },
    [nearby],
  );

  const applyCapabilities = useCallback(
    (
      caps: ProximityCapabilities,
      options: { afterRequest?: boolean; allowNoAdvertise?: boolean },
    ) => {
      const next = capabilityView(caps, options);
      if (next === 'ready') beginSearch(caps.canAdvertise);
      else dispatch({ type: 'view', view: next });
    },
    [beginSearch],
  );

  /** "Procurar por perto": confere permissão, Bluetooth e anúncio antes de procurar. */
  const startSearch = useCallback(
    async (options: { allowNoAdvertise?: boolean } = {}) => {
      try {
        applyCapabilities(await radio.getCapabilities(), options);
      } catch {
        dispatch({ type: 'view', view: { kind: 'btUnavailable' } });
      }
    },
    [applyCapabilities, radio],
  );
  const startSearchRef = useRef(startSearch);
  useEffect(() => {
    startSearchRef.current = startSearch;
  });

  /** "Continuar" na explicação: agora sim o pedido do sistema. */
  const requestBluetooth = useCallback(async () => {
    try {
      applyCapabilities(await radio.requestPermission(), { afterRequest: true });
    } catch {
      dispatch({ type: 'view', view: { kind: 'btUnavailable' } });
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
      if (bluetooth === 'off' && kind === 'searching') {
        dispatch({ type: 'view', view: { kind: 'btOff' } });
      } else if (bluetooth === 'on' && kind === 'btOff') {
        void startSearchRef.current();
      }
    });
    const errorSubscription = radio.onError((error) => {
      if (
        error.operation === 'advertise' &&
        error.code === 'unsupported' &&
        viewRef.current.kind === 'searching'
      ) {
        dispatch({ type: 'view', view: { kind: 'cannotAdvertise' } });
      }
    });
    return () => {
      stateSubscription.remove();
      errorSubscription.remove();
    };
  }, [radio]);

  // Voltou dos Ajustes: confere de novo a permissão e o Bluetooth.
  const wasLive = useRef(live);
  useEffect(() => {
    const returned = live && !wasLive.current;
    wasLive.current = live;
    const kind = viewRef.current.kind;
    if (returned && (kind === 'btDenied' || kind === 'btOff')) {
      void startSearchRef.current();
    }
  }, [live]);

  // --- Pedido (A) ---------------------------------------------------------------------------------

  const markConnected = useCallback(
    (other: ConnectionRequestParty) => {
      dispatch({ type: 'view', view: { kind: 'connected', other, at: connectClock.now() } });
      nearby.markConnected(other.handle);
      posts.showPostsOf(other.handle);
      announce(COPY.announceConnected);
      reloadUser().catch(() => undefined);
      // Primeira conexão: o pedido contextual de notificações (6.4 CA1), uma vez só.
      offerPush();
    },
    [nearby, offerPush, posts, reloadUser],
  );

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

  /** Pedido recusado pelo servidor: Toast do §5.2 (a recusa nunca é revelada). */
  const failCreate = useCallback(
    (error: unknown, viaBle: { handle: string; name: string } | null) => {
      if (isApiError(error, 'ALREADY_CONNECTED')) {
        if (viaBle !== null) nearby.markConnected(viaBle.handle);
        toast.show({ message: COPY.alreadyConnected });
        return;
      }
      if (isApiError(error, 'PROXIMITY_TOKEN_INVALID')) {
        if (viaBle !== null && !nearby.isPresent(viaBle.handle, connectTiming.goneAfterMs)) {
          nearby.forget(viaBle.handle);
          toast.show({ message: COPY.left(firstName(viaBle.name)), variant: 'error' });
        } else {
          toast.show({ message: COPY.cannotSend, variant: 'error' });
        }
        return;
      }
      if (error instanceof NetworkError) {
        toast.show({ message: OFFLINE_MESSAGE, variant: 'error' });
        return;
      }
      if (!halt(error)) toast.show({ message: messageForError(error), variant: 'error' });
    },
    [halt, nearby, toast],
  );

  /** "Conectar" numa linha de "Por perto agora", com o token mais recente da pessoa (PROX-25). */
  const connectTo = useCallback(
    async (row: NearbyRow) => {
      if (state.busy !== null) return;
      const token = nearby.latestToken(row.handle, TOKEN_TTL_MS);
      if (token === null || !nearby.isPresent(row.handle, connectTiming.goneAfterMs)) {
        nearby.forget(row.handle);
        toast.show({ message: COPY.left(firstName(row.name)), variant: 'error' });
        return;
      }
      dispatch({ type: 'busy', value: row.handle });
      try {
        afterCreated(await withScreenOpen(() => createConnectionRequest(api, token, 'ble')));
      } catch (error) {
        failCreate(error, { handle: row.handle, name: row.name });
      } finally {
        dispatch({ type: 'busy', value: null });
      }
    },
    [afterCreated, api, failCreate, nearby, state.busy, toast, withScreenOpen],
  );

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
      else dispatch({ type: 'view', view: START });
    } catch (error) {
      if (isApiError(error, 'NOT_FOUND')) dispatch({ type: 'view', view: START });
      else toast.show({ message: messageForError(error), variant: 'error' });
    } finally {
      dispatch({ type: 'busy', value: null });
    }
  }, [api, markConnected, toast]);

  /** "Tentar de novo" depois de "não confirmou": de volta à busca (ou ao QR). */
  const retryAfterNotConfirmed = useCallback(() => {
    const view = viewRef.current;
    if (view.kind === 'notConfirmed' && view.request.method === 'ble') {
      void startSearch();
    } else {
      dispatch({ type: 'view', view: START });
    }
  }, [startSearch]);

  // --- Pedido recebido (B) -------------------------------------------------------------------------

  const acceptWith = useCallback(
    async (request: ConnectionRequest, observedToken: string) => {
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
          fail(COPY.acceptFailed);
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
   * "Aceitar": por Bluetooth, com o token mais recente de A que este aparelho viu (até 120 s,
   * PROX-26); na simulação, com o token devolvido pela rota de dev; no QR, abre a câmera para ler o
   * código de A (D7).
   */
  const acceptHead = useCallback(async () => {
    if (head === null || sheetBusy) return;
    const { request } = head;
    const simulatedToken = simulated.get(request.id);
    if (simulatedToken === undefined && request.method === 'qr') {
      setScanner({ purpose: { kind: 'accept', request }, error: null, busy: false });
      return;
    }
    const token = simulatedToken ?? nearby.latestToken(request.other.handle, RECENT_TTL_MS);
    if (token === null) {
      setSheetError({ id: request.id, message: COPY.notSeen(firstName(request.other.name)) });
      return;
    }
    await acceptWith(request, token);
  }, [acceptWith, head, nearby, sheetBusy, simulated]);

  /** "Recusar": a folha fecha na hora. Quem pediu só vê "não confirmou". */
  const declineHead = useCallback(async () => {
    if (head === null) return;
    const { request } = head;
    incoming.dismiss(request.id);
    try {
      await declineConnectionRequest(api, request.id);
    } catch (error) {
      if (!isApiError(error, 'NOT_FOUND')) {
        toast.show({ message: messageForError(error), variant: 'error' });
      }
    }
  }, [api, head, incoming, toast]);

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

  /**
   * Um token lido de um QR (câmera do app ou deep link). Primeiro o `resolve` (não conta como
   * falha de token): QR vencido ou adulterado não cria nada (4.7 CA4). Depois: no aceite, confere
   * que o código é de quem pediu; senão, se a pessoa já me pediu, aceita; se não, pede (`qr`).
   */
  const handleQrToken = useCallback(
    async (token: string, purpose: ScannerPurpose, fromScanner: boolean) => {
      let person: NearbyPerson | undefined;
      try {
        person = (await withScreenOpen(() => resolveTokens(api, [token]))).items[0];
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
        await acceptWith(fromThem.request, person.token);
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
        failCreate(error, null);
      } finally {
        dispatch({ type: 'busy', value: null });
      }
    },
    [acceptWith, afterCreated, api, failCreate, halt, incoming, qrProblem, toast, withScreenOpen],
  );

  const scannerRef = useRef(scanner);
  useEffect(() => {
    scannerRef.current = scanner;
  });

  /** Leitura da câmera: o conteúdo precisa ser `sussurro://c/{token}` (senão, nada é enviado). */
  const onScanned = useCallback(
    async (data: string) => {
      const current = scannerRef.current;
      if (current === null || current.busy) return;
      const token = parseProximityQr(data);
      if (token === null) {
        if (current.error !== COPY.qrInvalid) setScanner({ ...current, error: COPY.qrInvalid });
        return;
      }
      const next = { ...current, busy: true, error: null };
      scannerRef.current = next;
      setScanner(next);
      await handleQrToken(token, current.purpose, true);
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

  // Deep link do QR (`sussurro://c/{token}`): espera o meu token (tela aberta no servidor).
  const handleQrTokenRef = useRef(handleQrToken);
  const linkRef = useRef({ isQrHandled, onQrHandled });
  useEffect(() => {
    handleQrTokenRef.current = handleQrToken;
    linkRef.current = { isQrHandled, onQrHandled };
  });
  useEffect(() => {
    if (qrParam === null || !active || ownToken === null) return;
    if (linkRef.current.isQrHandled(qrParam)) return;
    linkRef.current.onQrHandled(qrParam);
    const token = qrParam;
    void Promise.resolve().then(() => {
      dispatch({ type: 'mode', mode: 'qr' });
      if (ProximityTokenValueSchema.safeParse(token).success) {
        void handleQrTokenRef.current(token, { kind: 'auto' }, false);
      } else {
        toast.show({ message: COPY.qrInvalid, variant: 'error' });
      }
    });
  }, [active, ownToken, qrParam, toast]);

  // --- Simulação (só no build de desenvolvimento, 4.11) -------------------------------------------

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

  return {
    user,
    mode: state.mode,
    view: state.view,
    halt: state.halt,
    busy: state.busy,
    ownToken,
    nearby: nearby.snapshot,
    incoming: {
      head,
      secondsLeft: incoming.secondsLeft,
      error: sheetError !== null && sheetError.id === head?.request.id ? sheetError.message : null,
      busy: sheetBusy,
      simulated: head !== null && simulated.has(head.request.id),
    },
    scanner,
    simulationEnabled,
    actions: {
      setMode: (mode: ConnectMode) => {
        dispatch({ type: 'mode', mode });
      },
      startSearch: () => {
        void startSearch();
      },
      searchAnyway: () => {
        void startSearch({ allowNoAdvertise: true });
      },
      searchAgain: () => {
        if (state.view.kind === 'searching') beginSearch(state.view.advertise);
      },
      cancelSearch: () => {
        dispatch({ type: 'view', view: START });
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
      connectTo: (row: NearbyRow) => {
        void connectTo(row);
      },
      cancelRequest: () => {
        void cancelRequest();
      },
      retryAfterNotConfirmed,
      backToStart: () => {
        dispatch({ type: 'view', view: START });
      },
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
      resume: () => {
        void resume();
      },
    },
  };
}

export type ConnectSession = ReturnType<typeof useConnectSession>;
