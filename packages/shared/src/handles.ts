/**
 * Regras do @ (arquitetura.md §6, A-29): 3 a 30 caracteres de `[a-z0-9._]`, sempre minúsculo,
 * com ao menos uma letra ou dígito (`...` e `___` não valem), fora da lista de reservados.
 * O app e a API usam as mesmas funções.
 */
export const HANDLE_MIN_LENGTH = 3;
export const HANDLE_MAX_LENGTH = 30;
export const HANDLE_PATTERN = /^[a-z0-9._]{3,30}$/;

/** Prefixo reservado para contas da própria marca (ex.: `sussurro.oficial`). */
export const RESERVED_HANDLE_PREFIX = 'sussurro';

/** @ que ninguém pode usar: termos do sistema, da marca e de suporte (A-29). */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'about',
  'abuse',
  'admin',
  'administrador',
  'administrator',
  'ajuda',
  'api',
  'app',
  'cadastro',
  'conectar',
  'conta',
  'contato',
  'criador',
  'criar',
  'dev',
  'entrar',
  'equipe',
  'feed',
  'help',
  'inicio',
  'login',
  'logout',
  'me',
  'moderacao',
  'moderador',
  'nao.responda',
  'noreply',
  'notificacoes',
  'null',
  'oficial',
  'perfil',
  'pesquisar',
  'politica',
  'postmaster',
  'privacidade',
  'root',
  'security',
  'seguranca',
  'settings',
  'sistema',
  'sobre',
  'staff',
  'suporte',
  'support',
  'system',
  'termos',
  'undefined',
  'www',
]);

/** Como a API guarda o @: sem espaços nas pontas e em minúsculas. */
export function normalizeHandle(value: string): string {
  return value.trim().toLowerCase();
}

/** Formato válido (regex + ao menos uma letra ou dígito). Não olha a lista de reservados. */
export function isValidHandleFormat(handle: string): boolean {
  return HANDLE_PATTERN.test(handle) && /[a-z0-9]/.test(handle);
}

export function isReservedHandle(handle: string): boolean {
  const normalized = normalizeHandle(handle);
  return RESERVED_HANDLES.has(normalized) || normalized.startsWith(RESERVED_HANDLE_PREFIX);
}
