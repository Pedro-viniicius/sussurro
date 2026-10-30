import { createContext, type ReactNode, useContext } from 'react';

import { getProximityRadio, type ProximityRadio } from '../../../modules/sussurro-proximity';

const RadioContext = createContext<ProximityRadio | null>(null);

/** Troca o rádio BLE (os testes passam o falso; o app usa o nativo, se existir no build). */
export function RadioProvider({ value, children }: { value: ProximityRadio; children: ReactNode }) {
  return <RadioContext.Provider value={value}>{children}</RadioContext.Provider>;
}

export function useProximityRadio(): ProximityRadio {
  return useContext(RadioContext) ?? getProximityRadio();
}
