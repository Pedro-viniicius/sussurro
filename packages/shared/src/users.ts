import { z } from 'zod';

import { countChars, normalizeText } from './text.ts';

/** Tipo de conta, imutável depois do cadastro (ADR 0008, D17). */
export const AccountTypeSchema = z.enum(['personal', 'creator']);

export type AccountType = z.infer<typeof AccountTypeSchema>;

export const NAME_MAX_LENGTH = 60;
export const BIO_MAX_LENGTH = 150;

/** Nome: 1 a 60 caracteres (contados por `countChars`, TXT-04), sem quebra de linha. */
export const NameSchema = z
  .string()
  .transform((value) => normalizeText(value).trim())
  .pipe(
    z
      .string()
      .refine((value) => value.length > 0, { error: 'Informe o nome.' })
      .refine((value) => countChars(value) <= NAME_MAX_LENGTH, {
        error: `Use no máximo ${NAME_MAX_LENGTH} caracteres.`,
      })
      .refine((value) => !/[\n\t]/.test(value), { error: 'O nome não pode ter quebra de linha.' }),
  );

/** Bio: até 150 caracteres (TXT-04). Vazia (ou só espaços) vira `null`. */
export const BioSchema = z
  .string()
  .transform((value) => normalizeText(value).trim())
  .pipe(
    z.string().refine((value) => countChars(value) <= BIO_MAX_LENGTH, {
      error: `Use no máximo ${BIO_MAX_LENGTH} caracteres.`,
    }),
  )
  .transform((value) => (value === '' ? null : value));

const count = z.int().min(0);

/** Números públicos do perfil pessoal: só contagens, nunca listas (ADR 0004). */
export const PersonalCountsSchema = z.object({
  posts: count,
  connections: count,
  creators: count,
});

/** Números públicos do perfil de criador. Seguidores não têm lista nem para o dono. */
export const CreatorCountsSchema = z.object({
  posts: count,
  followers: count,
});

export type PersonalCounts = z.infer<typeof PersonalCountsSchema>;
export type CreatorCounts = z.infer<typeof CreatorCountsSchema>;

const profileFields = {
  handle: z.string(),
  name: z.string(),
  bio: z.string().nullable(),
  /** URL assinada do avatar a partir da Fase 2; `null` sem foto. */
  avatarUrl: z.url().nullable(),
};

const personalProfile = z.object({
  ...profileFields,
  accountType: z.literal('personal'),
  counts: PersonalCountsSchema,
});

const creatorProfile = z.object({
  ...profileFields,
  accountType: z.literal('creator'),
  counts: CreatorCountsSchema,
});

/**
 * `GET /users/:handle`. O interceptor de resposta (ADR 0004) remove qualquer campo fora deste
 * schema. PERM-11 trava a forma. (Fase 3) O perfil de criador traz `followedByMe` (o botão
 * Seguir/Seguindo); `counts.followers` tem cache de até 60 s (CNT-02) e nunca há lista, nem para o
 * próprio criador (PERM-09).
 */
export const PublicProfileSchema = z.discriminatedUnion('accountType', [
  personalProfile,
  creatorProfile.extend({
    /** O leitor segue este criador. Sempre `false` para quem não pode seguir (criador). */
    followedByMe: z.boolean(),
  }),
]);

export type PublicProfile = z.infer<typeof PublicProfileSchema>;

const ownFields = {
  id: z.uuid(),
  email: z.email(),
  /** O e-mail foi confirmado pelo link (história X.3). */
  emailVerified: z.boolean(),
  createdAt: z.iso.datetime(),
};

/** `GET /me`: o perfil público mais os dados da própria conta. */
export const MeSchema = z.discriminatedUnion('accountType', [
  personalProfile.extend(ownFields),
  creatorProfile.extend(ownFields),
]);

export type Me = z.infer<typeof MeSchema>;

/**
 * `PATCH /me`: só nome e bio. Qualquer outro campo (accountType, handle, email, id…) é recusado
 * com 400, sem alterar nada (PERM-07).
 */
export const UpdateMeRequestSchema = z.strictObject({
  name: NameSchema.optional(),
  bio: z.union([z.null(), BioSchema]).optional(),
});

export type UpdateMeRequest = z.infer<typeof UpdateMeRequestSchema>;
export type UpdateMeInput = z.input<typeof UpdateMeRequestSchema>;
