import type { AccountType } from '@sussurro/shared';

/**
 * Rotas do app (ux.md §3.2, adaptado: os grupos de abas viraram os segmentos `pessoal/` e `criador/`
 * para as duas barras não terem URLs iguais, ex.: dois `/perfil`).
 */
export const ROUTES = {
  signIn: '/entrar',
  signUp: '/cadastro',
  forgotPassword: '/esqueci-senha',
  personalHome: '/pessoal/inicio',
  personalNotifications: '/pessoal/inicio/notificacoes',
  personalSearch: '/pessoal/pesquisar',
  personalConnect: '/pessoal/conectar',
  personalProfile: '/pessoal/perfil',
  /** Listas próprias (3.6), só da conta pessoal. */
  personalConnections: '/pessoal/perfil/conexoes',
  personalFollowing: '/pessoal/perfil/seguindo',
  creatorProfile: '/criador/perfil',
  /** Conectar bloqueado para o criador (p22, 4.8 CA2): só por deep link. */
  creatorConnect: '/criador/conectar',
  create: '/criar',
  editProfile: '/editar-perfil',
  account: '/conta',
  deleteAccount: '/conta/excluir',
  /** Contas bloqueadas (X.2), nos dois tipos de conta. */
  blockedAccounts: '/conta/bloqueados',
  /** Denunciar (X.1): modal na raiz, com o alvo na query. */
  report: '/denunciar',
  verifyEmail: '/verificar-email',
} as const;

/**
 * Para onde vai quem abre a área do outro tipo de conta (história 1.9 CA4): a aba inicial do
 * próprio tipo. O criador que tenta abrir Conectar vê o p22 (4.8 CA2).
 */
export function redirectForOtherAccount(pathname: string, accountType: AccountType): string {
  if (accountType === 'creator' && pathname.startsWith(ROUTES.personalConnect)) {
    return ROUTES.creatorConnect;
  }
  return homeFor(accountType);
}

/** Aba inicial de cada tipo de conta: Início (pessoal) e Perfil (criador, D-UX17). */
export function homeFor(accountType: AccountType): string {
  return accountType === 'personal' ? ROUTES.personalHome : ROUTES.creatorProfile;
}

export function profileFor(accountType: AccountType): string {
  return accountType === 'personal' ? ROUTES.personalProfile : ROUTES.creatorProfile;
}
