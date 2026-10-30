import type { PushPlatform } from '@sussurro/shared';

export type PushPermissionStatus = 'granted' | 'denied' | 'undetermined';

/** Permissão de notificações do sistema (iOS e Android 13+). */
export interface PushPermission {
  status: PushPermissionStatus;
  /** `false` quando o sistema não mostra mais o pedido (só os Ajustes mudam). */
  canAskAgain: boolean;
}

/**
 * O que a pessoa escolheu neste aparelho, por conta: `on` (ativou) ou `off` (disse "Agora não",
 * negou no sistema ou desligou em Conta). `null` = ainda não foi perguntado: o pedido contextual
 * aparece uma vez só (6.4 CA4).
 */
export type PushChoice = 'on' | 'off';

export interface PushDeviceState {
  choice: PushChoice | null;
  /** Último token registrado com sucesso (`PUT /me/push-tokens`), para o `DELETE` ao desligar. */
  token: string | null;
}

/** Toque numa notificação: o `data` cru (validado depois com `PushDataSchema`) e um id. */
export interface PushResponse {
  id: string;
  data: unknown;
}

/**
 * Notificações do aparelho (história 6.4): permissão, token do Expo, toques e a escolha guardada.
 * O app usa a implementação nativa (`native-push.ts`, com `expo-notifications`); os testes trocam
 * por um dublê (`test-utils/fake-push.ts`).
 */
export interface PushPorts {
  /** `null` onde não há push (web). */
  platform: PushPlatform | null;
  getPermission: () => Promise<PushPermission>;
  /** Pedido do sistema (no Android, cria antes o canal; sem canal o Android 13+ não pergunta). */
  requestPermission: () => Promise<PushPermission>;
  /**
   * Token `ExponentPushToken[...]` deste aparelho. Falha sem o `projectId` do EAS, sem rede ou sem
   * as credenciais de push do projeto (APNs/FCM).
   */
  getToken: () => Promise<string>;
  /** Push recebido com o app aberto. Devolve a função que para de ouvir. */
  onReceived: (listener: () => void) => () => void;
  /** Toque numa notificação com o app aberto ou em segundo plano. */
  onResponse: (listener: (response: PushResponse) => void) => () => void;
  /** Toque que abriu o app fechado; devolvido uma vez só. */
  takeLaunchResponse: () => PushResponse | null;
  loadState: (userId: string) => Promise<PushDeviceState>;
  saveState: (userId: string, state: PushDeviceState) => Promise<void>;
  /** Ajustes do app no sistema (permissão negada de vez). */
  openSettings: () => Promise<void>;
}
