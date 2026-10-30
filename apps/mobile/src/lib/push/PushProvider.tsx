import { createContext, type ReactNode, useContext } from 'react';

import { nativePush } from './native-push';
import type { PushPorts } from './ports';

const PushContext = createContext<PushPorts>(nativePush);

/** Troca as notificações do aparelho (os testes passam o dublê; o app usa o `expo-notifications`). */
export function PushProvider({ value, children }: { value: PushPorts; children: ReactNode }) {
  return <PushContext.Provider value={value}>{children}</PushContext.Provider>;
}

export function usePushPorts(): PushPorts {
  return useContext(PushContext);
}
