import { Linking } from 'react-native';

/**
 * Site público do Sussurro (fora deste repositório, publicado pelo PO): Termos de uso e Política de
 * Privacidade (ux.md §4.7 e §8). Abre no navegador do sistema, sem módulo nativo novo.
 */
export const SITE_URL = 'https://sussurro-site.vercel.app';

export const LEGAL_URLS = {
  terms: `${SITE_URL}/termos`,
  privacy: `${SITE_URL}/privacidade`,
} as const;

export type LegalDocument = keyof typeof LEGAL_URLS;

/** Abre o documento legal; devolve `false` se o sistema não conseguiu abrir o link. */
export async function openLegal(document: LegalDocument): Promise<boolean> {
  try {
    await Linking.openURL(LEGAL_URLS[document]);
    return true;
  } catch {
    return false;
  }
}

export const LEGAL_OPEN_ERROR = 'Não foi possível abrir o link. Tente de novo.';
