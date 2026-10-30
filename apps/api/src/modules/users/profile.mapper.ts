import type { AccountType, Me, PublicProfile } from '@sussurro/shared';

export interface ProfileRow {
  id: string;
  email: string;
  handle: string;
  name: string;
  bio: string | null;
  avatarKey: string | null;
  accountType: AccountType;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

/**
 * Contagens brutas do perfil (ADR 0004: só números). Pessoal usa `connections` e `creators`;
 * criador usa `followers`.
 */
export interface ProfileCountValues {
  posts: number;
  connections: number;
  creators: number;
  followers: number;
}

/** Perfil com os números, sem os campos que dependem do leitor. */
function profileOf(row: ProfileRow, counts: ProfileCountValues, avatarUrl: string | null) {
  const base = { handle: row.handle, name: row.name, bio: row.bio, avatarUrl };
  return row.accountType === 'personal'
    ? {
        ...base,
        accountType: 'personal' as const,
        counts: {
          posts: counts.posts,
          connections: counts.connections,
          creators: counts.creators,
        },
      }
    : {
        ...base,
        accountType: 'creator' as const,
        counts: { posts: counts.posts, followers: counts.followers },
      };
}

/**
 * Perfil visto por outra conta: sem id, e-mail nem datas (PERM-11). O de criador traz
 * `followedByMe` (3.4); a lista de seguidores não existe (PERM-09).
 */
export function toPublicProfile(
  row: ProfileRow,
  counts: ProfileCountValues,
  avatarUrl: string | null,
  followedByMe: boolean,
): PublicProfile {
  const profile = profileOf(row, counts, avatarUrl);
  return profile.accountType === 'personal' ? profile : { ...profile, followedByMe };
}

/** `GET /me`: o perfil mais os dados da própria conta. */
export function toMe(row: ProfileRow, counts: ProfileCountValues, avatarUrl: string | null): Me {
  const own = {
    id: row.id,
    email: row.email,
    emailVerified: row.emailVerifiedAt !== null,
    createdAt: row.createdAt.toISOString(),
  };
  return { ...profileOf(row, counts, avatarUrl), ...own };
}
