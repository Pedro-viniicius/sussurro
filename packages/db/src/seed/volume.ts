import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import type { DbExecutor } from '../client.ts';
import {
  connections,
  follows,
  type NewPostMediaRow,
  type NewPostRow,
  postMedia,
  posts,
  users,
} from '../schema/index.ts';

/**
 * Seed volumoso para medir o feed (FEED-16, testes.md §2.2): 1 leitor com 150 conexões e 500
 * criadores seguidos, e 100 mil posts espalhados nos últimos 30 dias (metade texto, metade foto
 * com 1 imagem). O leitor é `leitor.volume` (`leitor.volume@example.com`, mesma senha do seed).
 */
export const VOLUME_READER_HANDLE = 'leitor.volume';

export interface VolumeOptions {
  passwordHash: string;
  now: Date;
  connections?: number;
  creators?: number;
  posts?: number;
  /** Dias para trás em que os posts são espalhados. */
  days?: number;
  /** Progresso no terminal (o seed leva alguns minutos no PGlite). */
  onProgress?: (message: string) => void;
}

export interface VolumeResult {
  created: boolean;
  authors: number;
  posts: number;
}

const BATCH = 1_000;

async function insertInBatches<T>(rows: T[], insert: (batch: T[]) => Promise<unknown>) {
  for (let start = 0; start < rows.length; start += BATCH) {
    await insert(rows.slice(start, start + BATCH));
  }
}

/** Idempotente: se o leitor já existe, não faz nada. */
export async function seedVolume(db: DbExecutor, options: VolumeOptions): Promise<VolumeResult> {
  const connectionCount = options.connections ?? 150;
  const creatorCount = options.creators ?? 500;
  const postCount = options.posts ?? 100_000;
  const days = options.days ?? 30;
  const log = options.onProgress ?? (() => undefined);

  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.handle, VOLUME_READER_HANDLE))
    .limit(1);
  if (existing !== undefined) {
    return { created: false, authors: 0, posts: 0 };
  }

  const base = {
    passwordHash: options.passwordHash,
    emailVerifiedAt: options.now,
    createdAt: options.now,
    updatedAt: options.now,
  };
  const reader = {
    id: randomUUID(),
    handle: VOLUME_READER_HANDLE,
    accountType: 'personal' as const,
  };
  const people = Array.from({ length: connectionCount }, (_, index) => ({
    id: randomUUID(),
    handle: `vol.p.${String(index)}`,
    accountType: 'personal' as const,
  }));
  const creators = Array.from({ length: creatorCount }, (_, index) => ({
    id: randomUUID(),
    handle: `vol.c.${String(index)}`,
    accountType: 'creator' as const,
  }));
  const accounts = [reader, ...people, ...creators];
  await insertInBatches(accounts, (batch) =>
    db.insert(users).values(
      batch.map((account) => ({
        ...base,
        ...account,
        email: `${account.handle}@example.com`,
        name: account.handle,
      })),
    ),
  );
  log(`${String(accounts.length)} contas criadas`);

  await insertInBatches(people, (batch) =>
    db.insert(connections).values(
      batch.map((person) => {
        const [userAId, userBId] = [reader.id, person.id].sort();
        return { userAId: userAId ?? '', userBId: userBId ?? '', method: 'qr' as const };
      }),
    ),
  );
  await insertInBatches(creators, (batch) =>
    db
      .insert(follows)
      .values(batch.map((creator) => ({ followerId: reader.id, creatorId: creator.id }))),
  );
  log(`${String(people.length)} conexões e ${String(creators.length)} follows`);

  const authors = [...people, ...creators];
  const spanMs = days * 24 * 60 * 60 * 1000;
  for (let start = 0; start < postCount; start += BATCH) {
    const postRows: NewPostRow[] = [];
    const mediaRows: NewPostMediaRow[] = [];
    for (let index = start; index < Math.min(start + BATCH, postCount); index++) {
      const author = authors[index % authors.length];
      if (author === undefined) {
        continue;
      }
      // Espalha de forma determinística (sem Math.random): a medição se repete igual.
      const at = new Date(
        options.now.getTime() - Math.floor(((index * 7919) % postCount) * (spanMs / postCount)),
      );
      const id = randomUUID();
      const isPhoto = index % 2 === 0;
      postRows.push({
        id,
        authorId: author.id,
        type: isPhoto ? 'photo' : 'text',
        status: 'published',
        text: isPhoto ? null : `Post de volume ${String(index)}`,
        caption: isPhoto ? `Foto de volume ${String(index)}` : null,
        createdAt: at,
        publishedAt: at,
      });
      if (isPhoto) {
        const mediaId = randomUUID();
        mediaRows.push({
          id: mediaId,
          postId: id,
          position: 0,
          kind: 'image',
          mime: 'image/jpeg',
          sizeBytes: 200_000,
          incomingKey: `incoming/${author.id}/${mediaId}`,
          storageKey: `media/${mediaId}/full.jpg`,
          thumbKey: `media/${mediaId}/thumb.jpg`,
          width: 1080,
          height: 1350,
          status: 'ready',
          createdAt: at,
          updatedAt: at,
        });
      }
    }
    await db.insert(posts).values(postRows);
    if (mediaRows.length > 0) {
      await db.insert(postMedia).values(mediaRows);
    }
    if ((start / BATCH) % 10 === 9) {
      log(`${String(start + BATCH)} posts`);
    }
  }
  log(`${String(postCount)} posts criados`);
  return { created: true, authors: authors.length, posts: postCount };
}
