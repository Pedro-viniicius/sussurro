import { Platform } from 'react-native';

/** Rótulo do aparelho guardado com a sessão (ex.: "iPhone · iOS 27"). Sem IP nem identificador. */
export function deviceLabel(
  os: string = Platform.OS,
  version: string | number = Platform.Version,
): string {
  switch (os) {
    case 'ios':
      return `iPhone · iOS ${String(version)}`;
    case 'android':
      return `Android · API ${String(version)}`;
    default:
      return os;
  }
}
