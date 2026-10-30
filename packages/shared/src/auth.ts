import { z } from 'zod';

import { HANDLE_PATTERN, isValidHandleFormat } from './handles.ts';
import { PASSWORD_MAX_LENGTH, passwordLength } from './passwords.ts';
import { AccountTypeSchema, MeSchema, NameSchema } from './users.ts';

/** E-mail: sem espaços nas pontas e em minúsculas antes de validar (AUTH-03). */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Digite um e-mail válido.' }).max(254));

/**
 * Senha recebida pela API: normalizada em NFC e com teto de 128 caracteres, verificado antes do
 * argon2 (anti-DoS, A-28). A força (mínimo de 8, lista de comuns) é checada pelo serviço, que
 * responde `WEAK_PASSWORD`.
 */
export const PasswordInputSchema = z
  .string()
  .normalize('NFC')
  .refine((value) => value.length > 0, { error: 'Informe a senha.' })
  .refine((value) => passwordLength(value) <= PASSWORD_MAX_LENGTH, {
    error: `Use no máximo ${PASSWORD_MAX_LENGTH} caracteres.`,
  });

/** @ no cadastro: convertido para minúsculas e validado pelo formato (AUTH-04). */
export const HandleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(
    z
      .string()
      .regex(HANDLE_PATTERN, { error: 'Use de 3 a 30 letras, números, ponto ou _.' })
      .refine(isValidHandleFormat, { error: 'Use ao menos uma letra ou um número.' }),
  );

/** Rótulo do aparelho guardado com a sessão (ex.: "iPhone · iOS 27"). Sem IP (minimização). */
export const DeviceLabelSchema = z.string().trim().max(100);

/** `POST /auth/register`. Sem `accountType`, vale `personal` (padrão da especificação, AUTH-05). */
export const RegisterRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordInputSchema,
  handle: HandleSchema,
  name: NameSchema,
  accountType: AccountTypeSchema.default('personal'),
  deviceLabel: DeviceLabelSchema.optional(),
});

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type RegisterInput = z.input<typeof RegisterRequestSchema>;

/** `POST /auth/login`: só e-mail (D14). */
export const LoginRequestSchema = z.object({
  email: EmailSchema,
  password: PasswordInputSchema,
  deviceLabel: DeviceLabelSchema.optional(),
});

export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginInput = z.input<typeof LoginRequestSchema>;

/** Token opaco (refresh, verificação de e-mail, redefinição de senha). */
const OpaqueTokenSchema = z.string().min(1).max(200);

/** `POST /auth/refresh`. */
export const RefreshRequestSchema = z.object({ refreshToken: OpaqueTokenSchema });

export type RefreshRequest = z.infer<typeof RefreshRequestSchema>;

/** `POST /auth/password/forgot`: a resposta é sempre 202, exista o e-mail ou não (1.10 CA1). */
export const ForgotPasswordRequestSchema = z.object({ email: EmailSchema });

export type ForgotPasswordRequest = z.infer<typeof ForgotPasswordRequestSchema>;

/** `POST /auth/password/reset`: token do link + senha nova. Revoga todas as sessões. */
export const ResetPasswordRequestSchema = z.object({
  token: OpaqueTokenSchema,
  password: PasswordInputSchema,
});

export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

/** `POST /auth/email/verify`: token do link de confirmação (X.3). */
export const VerifyEmailRequestSchema = z.object({ token: OpaqueTokenSchema });

export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;

/** `DELETE /me`: a exclusão pede a senha (A-15, D-UX18). */
export const DeleteMeRequestSchema = z.object({ password: PasswordInputSchema });

export type DeleteMeRequest = z.infer<typeof DeleteMeRequestSchema>;

/**
 * Par de tokens (ADR 0007): access JWT de 15 min, só em memória no app; refresh opaco de 30 dias,
 * rotacionado a cada uso e guardado no secure-store.
 */
export const TokenPairSchema = z.object({
  accessToken: z.string().min(1),
  accessTokenExpiresAt: z.iso.datetime(),
  refreshToken: z.string().min(1),
  refreshTokenExpiresAt: z.iso.datetime(),
});

export type TokenPair = z.infer<typeof TokenPairSchema>;

/** Resposta do cadastro e do login. */
export const AuthSessionSchema = z.object({
  user: MeSchema,
  tokens: TokenPairSchema,
});

export type AuthSession = z.infer<typeof AuthSessionSchema>;
