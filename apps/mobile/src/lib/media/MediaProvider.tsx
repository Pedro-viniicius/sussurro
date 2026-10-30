import { createContext, type ReactNode, useContext } from 'react';

import { nativeMedia } from './native-media';
import type { MediaPorts } from './ports';

const MediaContext = createContext<MediaPorts>(nativeMedia);

/** Troca o acesso às fotos e ao S3 (os testes passam dublês; o app usa o padrão nativo). */
export function MediaProvider({ value, children }: { value: MediaPorts; children: ReactNode }) {
  return <MediaContext.Provider value={value}>{children}</MediaContext.Provider>;
}

export function useMedia(): MediaPorts {
  return useContext(MediaContext);
}
