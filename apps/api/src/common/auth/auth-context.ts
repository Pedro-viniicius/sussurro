import type { AccountType } from '@sussurro/shared';
import type { Request } from 'express';

/**
 * Quem está chamando, extraído do access token pelo guard de autenticação. As regras de permissão
 * recebem este contexto (nunca um `userId` vindo do cliente, ADR 0004).
 */
export interface AuthContext {
  userId: string;
  /** Tipo de conta (claim `acct`, imutável). */
  accountType: AccountType;
  /** Família de refresh do aparelho (claim `fam`): o logout revoga só ela. */
  familyId: string;
  /**
   * E-mail confirmado (X.3), lido do banco a cada requisição pelo guard de autenticação: a
   * confirmação vale na hora, sem esperar o access token vencer.
   */
  emailVerified: boolean;
}

export interface AuthenticatedRequest extends Request {
  auth?: AuthContext;
}
