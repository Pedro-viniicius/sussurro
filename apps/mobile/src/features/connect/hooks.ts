import type { ProximityToken } from '@sussurro/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { issueProximityToken } from './api';
import { isRepeatableFailure, TokenWaitCancelled } from './errors';
import { connectClock, connectTiming } from './timing';
import type { ApiClient } from '../../lib/api/client';

/**
 * `false` com o app em background. O "inactive" do iOS (alerta do sistema, central de controle)
 * conta como ativo: só o background para a tela Conectar.
 */
export function useAppActive(): boolean {
  const [active, setActive] = useState(() => AppState.currentState !== 'background');

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setActive(next !== 'background');
    });
    return () => {
      subscription.remove();
    };
  }, []);

  return active;
}

/**
 * Roda `task` agora e de novo `intervalMs` depois de cada fim, enquanto `active` (sem chamadas
 * sobrepostas). Erros ficam com a própria tarefa.
 */
export function usePolling(task: () => Promise<void>, intervalMs: number, active: boolean): void {
  const taskRef = useRef(task);
  useEffect(() => {
    taskRef.current = task;
  });

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        await taskRef.current();
      } catch {
        // A tarefa trata (ou ignora) os próprios erros; o polling continua.
      }
      if (!cancelled) {
        timer = setTimeout(() => {
          void run();
        }, intervalMs);
      }
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, intervalMs]);
}

/**
 * As emissões de token dos últimos 60 s (PROX-68), da mais antiga à mais nova, **da sessão
 * inteira**: ficam no módulo, fora do componente. Assim, sair da aba (a tela Conectar desmonta) e
 * voltar não zera a contagem, e o servidor, que conta por conta, nunca vê mais emissões que o app.
 * Só guardam instantes, nenhum dado da pessoa. Saem no fim da sessão
 * (`useProximityTokenSessionScope`), porque o limite do servidor é da conta: a conta seguinte
 * começa com a janela vazia.
 */
const tokenIssueWindow: { issuedAt: number[] } = { issuedAt: [] };

/** Esquece as emissões da sessão (no fim dela, e entre um teste e outro). */
export function forgetTokenIssues(): void {
  tokenIssueWindow.issuedAt = [];
}

/**
 * A janela das emissões acompanha a sessão: a pilha raiz chama com o `id` da conta logada (ou
 * `null`), e, quando ele muda (sair, sair de todos, excluir a conta, redefinir a senha, sessão
 * expirada ou revogada, troca de conta), a janela é esquecida. A limpeza roda no fim do efeito da
 * conta anterior, no mesmo commit em que a tela Conectar desmonta.
 */
export function useProximityTokenSessionScope(ownerId: string | null): void {
  useEffect(
    () => () => {
      forgetTokenIssues();
    },
    [ownerId],
  );
}

/** A emissão que espera a vaga ou já está em voo, e que todos os pedidos de token compartilham. */
interface PendingIssue {
  promise: Promise<ProximityToken>;
  /** Cancela a espera pela vaga, se a emissão ainda não saiu (a em voo segue até a resposta). */
  cancelWait: () => void;
}

/**
 * Meu token de proximidade enquanto a tela Conectar está aberta (ADR 0003 e 0013 §1): pede agora e
 * renova a cada `renewInS` (20 s), sem esperar vencer. O token anterior continua valendo até o novo
 * chegar, então o QR e o NFC não piscam com a tela aberta (4.2 CA3).
 *
 * Erros: na renovação, a falha repetível (sem rede, 5xx) tenta de novo a cada `tokenRetryMs` (3 s),
 * até `tokenRetries` (3) vezes, e só então vai para `onError`; os outros erros, e qualquer erro do
 * 1º pedido da visita (sem token ainda), vão na hora. O `onError` para a renovação (a tela decide o
 * estado). `refresh` pede um token fora do ciclo (o 409 de "tela fechada" no `resolve`, no pedido e
 * no aceite), sem repetir: quem chama decide.
 *
 * Teto (PROX-68): as tentativas zeram a cada sucesso, então, numa rede ruim, a renovação faria até 9
 * emissões em 60 s, e a 7ª levaria o 429 do servidor (6 por minuto): a tela pararia em "Muitas
 * tentativas", o motivo errado. O hook conta as emissões (cada pedido pode ter chegado ao servidor,
 * mesmo sem resposta) numa janela móvel de 60 s, que vale para a sessão inteira
 * (`tokenIssueWindow`), não para a montagem da tela:
 * - a tentativa de novo que passaria do teto não sai: vai para `onError` o último erro repetível
 *   (sem rede, indisponível), como no fim das 3 tentativas;
 * - o 1º pedido da visita, a renovação de 20 s e o `refresh`, com a janela cheia, esperam a vaga e
 *   então saem. Sem isso, a 7ª emissão levaria o 429 e trocaria o motivo da tela por "Muitas
 *   tentativas" (a aba aberta 6 vezes em 25 s, por exemplo, ou o "Tentar de novo" logo depois da
 *   parada pelo teto). Os três dividem **uma** emissão: quem chega com outra esperando a vaga ou em
 *   voo espera por ela, em vez de gastar outra. Quem chamou o `refresh` fica no carregando até a
 *   resposta, como numa chamada lenta;
 * - a espera é cancelada quando a tela para, vai para o segundo plano ou fecha: a emissão não sai
 *   com a tela fechada, e o `refresh` que esperava falha com `TokenWaitCancelled`, em silêncio. O
 *   `refresh` pedido com a tela já inativa ou desmontada (o 409 que chega depois de sair da aba)
 *   falha do mesmo jeito, na hora, com ou sem vaga: nenhum `refresh` emite com a tela do Conectar
 *   inativa, nem com a sessão de outra conta (MÉDIO do `seguranca`).
 *
 * Token na parada (C4): com `halted` (a tela parada, 18 a 20), o token de antes sai, e o "Tentar de
 * novo" começa sem ele. A validade é de 30 s, e a parada vem depois de falhas: o QR mostraria, e o
 * NFC emitiria, um código vencido. Sem token, o QR mostra o carregando e o NFC não emite até a nova
 * emissão. Na volta do segundo plano (sem parada), o token de antes continua.
 */
export function useProximityToken(
  api: ApiClient,
  active: boolean,
  onError: (error: unknown) => void,
  halted = false,
): { token: string | null; refresh: () => Promise<void> } {
  const [token, setToken] = useState<string | null>(null);
  // C4: a parada tira o token de antes. Ajustado no render, quando `halted` muda (o padrão do React
  // para o estado que acompanha uma prop), sem um efeito a mais.
  const [wasHalted, setWasHalted] = useState(halted);
  if (halted !== wasHalted) {
    setWasHalted(halted);
    if (halted) setToken(null);
  }
  const onErrorRef = useRef(onError);
  /** `active` e `halted` de agora, para as esperas e respostas que chegam depois do render. */
  const liveRef = useRef({ active, halted });
  useEffect(() => {
    onErrorRef.current = onError;
    liveRef.current = { active, halted };
  });
  const pendingRef = useRef<PendingIssue | null>(null);

  /**
   * A próxima emissão: a que já espera a vaga ou está em voo, se houver; senão, uma nova, que sai na
   * hora ou quando abrir a vaga. Conta antes de pedir (o pedido pode chegar ao servidor mesmo sem
   * resposta). O token que chega com a tela parada não entra (C4).
   */
  const nextIssue = useCallback((): Promise<ProximityToken> => {
    const current = pendingRef.current;
    if (current !== null) return current.promise;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectWait: ((reason: unknown) => void) | null = null;
    const promise = new Promise<ProximityToken>((resolve, reject) => {
      const attempt = () => {
        // Com a tela fechada, parada ou em segundo plano, nada é emitido, com ou sem vaga (MÉDIO do
        // `seguranca`): a emissão abriria no servidor uma tela que ninguém vê e podia sair com a
        // sessão de outra conta. E a espera que começasse agora, ninguém cancelaria.
        if (!liveRef.current.active) {
          rejectWait = null;
          reject(new TokenWaitCancelled());
          return;
        }
        const now = connectClock.now();
        if (!roomForIssue(tokenIssueWindow.issuedAt, now)) {
          rejectWait = reject;
          timer = setTimeout(attempt, msUntilRoom(tokenIssueWindow.issuedAt, now));
          return;
        }
        rejectWait = null;
        tokenIssueWindow.issuedAt.push(now);
        issueProximityToken(api).then((result) => {
          if (!liveRef.current.halted) setToken(result.token);
          resolve(result);
        }, reject);
      };
      attempt();
    });
    const entry: PendingIssue = {
      promise,
      cancelWait: () => {
        if (rejectWait === null) return;
        clearTimeout(timer);
        rejectWait(new TokenWaitCancelled());
        rejectWait = null;
      },
    };
    pendingRef.current = entry;
    const settle = () => {
      if (pendingRef.current === entry) pendingRef.current = null;
    };
    promise.then(settle, settle);
    return promise;
  }, [api]);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    /** Já houve emissão nesta visita: as seguintes são renovações. */
    let renewing = false;
    /** Tentativas de novo da renovação em curso. */
    let retries = 0;
    /** A última falha repetível da renovação em curso (a próxima ida é uma tentativa de novo). */
    let failure: { error: unknown } | null = null;
    const run = async () => {
      if (failure !== null && !roomForIssue(tokenIssueWindow.issuedAt, connectClock.now())) {
        onErrorRef.current(failure.error);
        return;
      }
      let nextInMs: number;
      try {
        const result = await nextIssue();
        if (cancelled) return;
        renewing = true;
        retries = 0;
        failure = null;
        nextInMs = result.renewInS * 1000;
      } catch (error) {
        if (cancelled || error instanceof TokenWaitCancelled) return;
        if (!renewing || retries >= connectTiming.tokenRetries || !isRepeatableFailure(error)) {
          onErrorRef.current(error);
          return;
        }
        retries += 1;
        failure = { error };
        nextInMs = connectTiming.tokenRetryMs;
      }
      timer = setTimeout(() => {
        void run();
      }, nextInMs);
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      // A tela parou, foi para o segundo plano ou fechou. Ao sair da aba, ela desmonta sem passar
      // por um render com `active = false`, e o `liveRef` ficaria `true` para sempre: um `refresh`
      // chamado depois emitiria com a tela fechada. Marcado aqui, nenhum pedido novo sai. Numa visita
      // que continua (a troca do `api`), o efeito que sincroniza o `liveRef` o põe de volta no mesmo
      // commit, antes de este efeito rodar de novo.
      liveRef.current = { ...liveRef.current, active: false };
      // A emissão que esperava a vaga não sai.
      pendingRef.current?.cancelWait();
    };
  }, [active, nextIssue]);

  const refresh = useCallback(async () => {
    await nextIssue();
  }, [nextIssue]);

  return { token, refresh };
}

/** Esquece as emissões de mais de `tokenIssueWindowMs` (60 s). */
function forgetOldIssues(issuedAt: number[], now: number): void {
  while (issuedAt.length > 0 && now - (issuedAt[0] ?? now) >= connectTiming.tokenIssueWindowMs) {
    issuedAt.shift();
  }
}

/**
 * Cabe mais uma emissão no teto do servidor (PROX-68): no máximo `tokenIssueLimit` (6) em qualquer
 * janela de `tokenIssueWindowMs` (60 s).
 */
function roomForIssue(issuedAt: number[], now: number): boolean {
  forgetOldIssues(issuedAt, now);
  return issuedAt.length < connectTiming.tokenIssueLimit;
}

/**
 * Quanto falta para abrir uma vaga na janela cheia: a emissão que sai dela é a que deixa só
 * `tokenIssueLimit − 1` (5) dentro dos 60 s.
 */
function msUntilRoom(issuedAt: number[], now: number): number {
  const leaving = issuedAt[issuedAt.length - connectTiming.tokenIssueLimit] ?? now;
  return Math.max(0, leaving + connectTiming.tokenIssueWindowMs - now);
}
