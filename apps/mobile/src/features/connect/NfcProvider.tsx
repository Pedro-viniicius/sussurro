import { createContext, type ReactNode, useContext } from 'react';

import { getNfc, type Nfc } from '../../../modules/sussurro-proximity';

const NfcContext = createContext<Nfc | null>(null);

/** Troca o NFC (os testes passam o falso; o app usa o nativo, se existir no build). */
export function NfcProvider({ value, children }: { value: Nfc; children: ReactNode }) {
  return <NfcContext.Provider value={value}>{children}</NfcContext.Provider>;
}

export function useNfc(): Nfc {
  return useContext(NfcContext) ?? getNfc();
}
