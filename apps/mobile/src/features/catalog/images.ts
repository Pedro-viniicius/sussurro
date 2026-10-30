import { Image } from 'react-native';

import areia from '../../../assets/catalog/paisagem-areia.png';
import azul from '../../../assets/catalog/paisagem-azul.png';
import verde from '../../../assets/catalog/paisagem-verde.png';

/**
 * Imagens locais no estilo de p03 para o catálogo (ux.md §6.15), geradas por
 * `pnpm --filter @sussurro/mobile generate-catalog-images`. Viram URIs porque os componentes de post
 * recebem `uri` (como as URLs assinadas da API).
 */
function uriOf(asset: number): string | null {
  const resolved = Image.resolveAssetSource(asset) as { uri?: string } | null | undefined;
  return resolved?.uri ?? null;
}

export const catalogImages = [
  { key: 'catalogo-azul', uri: uriOf(azul) },
  { key: 'catalogo-verde', uri: uriOf(verde) },
  { key: 'catalogo-areia', uri: uriOf(areia) },
] as const;
