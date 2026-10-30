import { randomUUID } from 'node:crypto';

import { and, eq, inArray, type SQL, sql } from 'drizzle-orm';

import type { DbExecutor } from '../client.ts';
import {
  blocks,
  comments,
  connections,
  follows,
  likes,
  type NewPostMediaRow,
  type NewPostRow,
  postMedia,
  posts,
  reports,
  users,
} from '../schema/index.ts';

export interface Persona {
  handle: string;
  name: string;
  email: string;
  accountType: 'personal' | 'creator';
  bio: string | null;
}

/** Personas do protótipo (testes.md §1.6, A-08). */
export const PERSONAS: readonly Persona[] = [
  {
    handle: 'helena',
    name: 'Helena Souza',
    email: 'helena@example.com',
    accountType: 'personal',
    bio: 'Arquiteta. Café coado, caminhadas longas e livros usados.',
  },
  {
    handle: 'caio.r',
    name: 'Caio Ribeiro',
    email: 'caio@example.com',
    accountType: 'personal',
    bio: null,
  },
  {
    handle: 'marinac',
    name: 'Marina Costa',
    email: 'marina@example.com',
    accountType: 'personal',
    bio: 'Domingo de manhã no Passaúna.',
  },
  {
    handle: 'cozinhadabia',
    name: 'Beatriz Lemos',
    email: 'bia@example.com',
    accountType: 'creator',
    bio: 'Receitas de casa, sem pressa. Toda quinta tem pão novo.',
  },
  {
    handle: 'trilhasdosul',
    name: 'Rafael Duarte',
    email: 'rafael@example.com',
    accountType: 'creator',
    bio: 'Trilhas e acampamentos no Sul do Brasil.',
  },
  // Fase 3: busca de criadores. Prefixos parecidos com os @ pessoais (BUS-04): `estu` acha os dois
  // estúdios e nunca @estudante; `hele` acha @helenaviaja e nunca @helena.
  {
    handle: 'estudante',
    name: 'Lia Martins',
    email: 'lia@example.com',
    accountType: 'personal',
    bio: 'Estudante de design. Câmera analógica sempre na bolsa.',
  },
  {
    handle: 'estudioaurora',
    name: 'Estúdio Aurora',
    email: 'aurora@example.com',
    accountType: 'creator',
    bio: 'Fotografia de luz natural. Retratos e cidade.',
  },
  {
    handle: 'estudiovinil',
    name: 'Estúdio Vinil',
    email: 'vinil@example.com',
    accountType: 'creator',
    bio: 'Discos, toca-discos e a história por trás de cada capa.',
  },
  {
    handle: 'helenaviaja',
    name: 'Helena Prado',
    email: 'helenaprado@example.com',
    accountType: 'creator',
    bio: 'Roteiros de viagem de baixo custo pela América do Sul.',
  },
  // Fase 4: pessoas sem nenhuma conexão, para a simulação de pedido recebido em desenvolvimento
  // (`POST /v1/dev/simulate-request`: @lucasf por padrão, ou @tomas) e para testar o Conectar com
  // dois aparelhos. caio.r e marinac também não são conexão um do outro.
  {
    handle: 'lucasf',
    name: 'Lucas Ferreira',
    email: 'lucas@example.com',
    accountType: 'personal',
    bio: 'Professor de música. Violão na mochila.',
  },
  {
    handle: 'tomas',
    name: 'Tomás Andrade',
    email: 'tomas@example.com',
    accountType: 'personal',
    bio: 'Estudante de engenharia. Sempre no show da sexta.',
  },
];

/**
 * Relacionamentos do seed (A-08: o feed da Fase 2 é demonstrado com eles, porque seguir chega na
 * Fase 3 e conectar na Fase 4). Caio e Marina não são conexão um do outro: Caio nunca vê os posts
 * de Marina, e vice-versa (privacidade da conta pessoal).
 */
export const SEED_CONNECTIONS: readonly (readonly [string, string])[] = [
  ['helena', 'caio.r'],
  ['helena', 'marinac'],
];

export const SEED_FOLLOWS: readonly (readonly [string, string])[] = [
  ['helena', 'cozinhadabia'],
  ['helena', 'trilhasdosul'],
  ['caio.r', 'cozinhadabia'],
  ['marinac', 'trilhasdosul'],
  // Fase 3.
  ['estudante', 'estudioaurora'],
  ['caio.r', 'estudiovinil'],
];

/**
 * Bloqueio de exemplo (X.2, Fase 3): @trilhasdosul (criador) bloqueou @estudante. Para @estudante,
 * o criador some da busca (`tri`) e o perfil dele dá o 404 de inexistente.
 */
export const SEED_BLOCKS: readonly (readonly [string, string])[] = [['trilhasdosul', 'estudante']];

/** Denúncia de exemplo (X.1, Fase 3): @helena denunciou a conta @estudiovinil. */
export const SEED_REPORTS: readonly {
  reporter: string;
  account: string;
  reason: 'spam';
  details: string;
}[] = [
  {
    reporter: 'helena',
    account: 'estudiovinil',
    reason: 'spam',
    details: 'Só publica propaganda de loja.',
  },
];

interface SeedPost {
  /** Chave interna, para curtidas e comentários do seed. */
  key: string;
  author: string;
  type: 'text' | 'photo';
  text?: string;
  caption?: string;
  /** Fotos (1 a 4) de um post `photo`. */
  photos?: number;
  /** Há quantos minutos foi publicado. A janela padrão do feed é 72 h (4320 min). */
  minutesAgo: number;
}

const HOUR = 60;

/** Posts de foto e texto em horários variados, dentro e fora da janela de 72 h. */
export const SEED_POSTS: readonly SeedPost[] = [
  {
    key: 'marina-passauna',
    author: 'marinac',
    type: 'photo',
    photos: 3,
    caption: 'Domingo de manhã no Passaúna. A neblina levou uma hora para ir embora.',
    minutesAgo: 18,
  },
  {
    key: 'caio-cafe',
    author: 'caio.r',
    type: 'text',
    text: 'Alguém mais acha que o café da padaria da esquina ficou melhor depois da reforma?',
    minutesAgo: 40,
  },
  {
    key: 'helena-livros',
    author: 'helena',
    type: 'text',
    text: 'Achei uma primeira edição de Lavoura Arcaica num sebo do centro. Ainda estou tremendo.',
    minutesAgo: 2 * HOUR,
  },
  {
    key: 'bia-pao',
    author: 'cozinhadabia',
    type: 'photo',
    photos: 1,
    caption: 'Pão de fermentação natural da semana. Receita completa no próximo post.',
    minutesAgo: 3 * HOUR,
  },
  {
    key: 'marina-texto',
    author: 'marinac',
    type: 'text',
    text: 'Plantei manjericão, alecrim e hortelã na varanda. Torcendo para o gato não descobrir.',
    minutesAgo: 5 * HOUR,
  },
  {
    key: 'helena-obra',
    author: 'helena',
    type: 'photo',
    photos: 2,
    caption: 'Visita de obra: a luz da tarde entrando pelo cobogó.',
    minutesAgo: 20 * HOUR,
  },
  {
    key: 'bia-dica',
    author: 'cozinhadabia',
    type: 'text',
    text: 'Dica rápida: deixe a manteiga fora da geladeira 30 minutos antes de fazer a massa.',
    minutesAgo: 26 * HOUR,
  },
  {
    key: 'trilhas-serra',
    author: 'trilhasdosul',
    type: 'photo',
    photos: 4,
    caption: 'Travessia da Serra do Mar em quatro fotos. Saímos às 5h e chegamos com o pôr do sol.',
    minutesAgo: 40 * HOUR,
  },
  {
    key: 'caio-bike',
    author: 'caio.r',
    type: 'text',
    text: 'Primeira vez indo trabalhar de bicicleta. 12 km e um joelho reclamando.',
    minutesAgo: 50 * HOUR,
  },
  {
    key: 'trilhas-previsao',
    author: 'trilhasdosul',
    type: 'text',
    text: 'Previsão de frente fria no fim de semana: adiem a subida do Marumbi.',
    minutesAgo: 70 * HOUR,
  },
  // Fora da janela de 72 h: aparecem no perfil, nunca no feed.
  {
    key: 'trilhas-antigo',
    author: 'trilhasdosul',
    type: 'text',
    text: 'Lista do que levar numa trilha de um dia (versão 2026).',
    minutesAgo: 73 * HOUR,
  },
  {
    key: 'caio-antigo',
    author: 'caio.r',
    type: 'text',
    text: 'Domingo de chuva, maratona de filmes antigos.',
    minutesAgo: 80 * HOUR,
  },
  {
    key: 'bia-antigo',
    author: 'cozinhadabia',
    type: 'photo',
    photos: 1,
    caption: 'Bolo de fubá com goiabada, receita da minha avó.',
    minutesAgo: 100 * HOUR,
  },
  // Fase 3: criadores da busca.
  {
    key: 'aurora-retrato',
    author: 'estudioaurora',
    type: 'photo',
    photos: 2,
    caption: 'Retratos na janela, só com a luz das 16h.',
    minutesAgo: 6 * HOUR,
  },
  {
    key: 'vinil-texto',
    author: 'estudiovinil',
    type: 'text',
    text: 'Limpe a agulha antes de limpar o disco. Nessa ordem.',
    minutesAgo: 9 * HOUR,
  },
  {
    key: 'helenaviaja-texto',
    author: 'helenaviaja',
    type: 'text',
    text: 'Salta, Cafayate e Cachi em cinco dias, de ônibus. Roteiro completo amanhã.',
    minutesAgo: 30 * HOUR,
  },
  // Fase 4: aparecem no feed de quem se conectar com eles (e somem ao desfazer a conexão).
  {
    key: 'lucas-texto',
    author: 'lucasf',
    type: 'text',
    text: 'Aula de violão no parque no sábado de manhã. Quem quiser, aparece.',
    minutesAgo: 4 * HOUR,
  },
  {
    key: 'tomas-texto',
    author: 'tomas',
    type: 'text',
    text: 'Show de abertura cancelado, mas a banda tocou na calçada mesmo.',
    minutesAgo: 12 * HOUR,
  },
];

const SEED_LIKES: readonly (readonly [string, string])[] = [
  ['helena', 'marina-passauna'],
  ['caio.r', 'helena-livros'],
  ['marinac', 'helena-livros'],
  ['helena', 'bia-pao'],
  ['caio.r', 'bia-pao'],
  ['helena', 'trilhas-serra'],
];

interface SeedComment {
  post: string;
  author: string;
  body: string;
  minutesAgo: number;
  /** Responde ao comentário de índice `replyTo` desta lista. */
  replyTo?: number;
}

const SEED_COMMENTS: readonly SeedComment[] = [
  { post: 'helena-livros', author: 'caio.r', body: 'Que achado! Quanto custou?', minutesAgo: 90 },
  {
    post: 'helena-livros',
    author: 'helena',
    body: 'Menos do que um almoço. Não conto mais nada.',
    minutesAgo: 80,
    replyTo: 0,
  },
  {
    post: 'bia-pao',
    author: 'helena',
    body: 'Qual a hidratação dessa massa?',
    minutesAgo: 150,
  },
  {
    post: 'bia-pao',
    author: 'cozinhadabia',
    body: '75%, com 20% de integral. Conto tudo na quinta!',
    minutesAgo: 140,
    replyTo: 2,
  },
];

interface SeedReel {
  author: string;
  caption: string;
  /** Duração do vídeo (até 90 s, D10). */
  durationS: number;
  minutesAgo: number;
}

/**
 * Reels de exemplo (Fase 5): só as linhas, com as chaves do S3 no formato do worker
 * (`media/{id}/video.mp4` e `poster.jpg`, 720×1280). `pnpm --filter @sussurro/worker seed:media`
 * grava o poster (degradê) e um MP4 de exemplo que não toca: para assistir, publique um vídeo pelo
 * app. marinac é pessoal: o reel dela só aparece para helena (conexão), nunca para caio.r.
 */
export const SEED_REELS: readonly SeedReel[] = [
  {
    author: 'marinac',
    caption: 'A neblina subindo no Passaúna, em 15 segundos.',
    durationS: 15,
    minutesAgo: 30,
  },
  {
    author: 'trilhasdosul',
    caption: 'Trilha do Itupava: a ponte do rio Taquaral.',
    durationS: 42,
    minutesAgo: 2 * HOUR,
  },
  {
    author: 'cozinhadabia',
    caption: 'Dobras da massa do pão, passo a passo.',
    durationS: 58.4,
    minutesAgo: 8 * HOUR,
  },
  {
    author: 'helena',
    caption: 'Chuva de fim de tarde na janela do escritório.',
    durationS: 27,
    minutesAgo: 50 * HOUR,
  },
  // Fora da janela de 72 h, com a duração máxima: só no perfil.
  {
    author: 'trilhasdosul',
    caption: 'Amanhecer no Pico Paraná (90 s, sem cortes).',
    durationS: 90,
    minutesAgo: 90 * HOUR,
  },
];

export interface SeedResult {
  created: string[];
  skipped: string[];
  /** Posts criados nesta execução (0 se todas as personas já tinham posts). */
  posts: number;
  /** Reels criados nesta execução (Fase 5; 0 se os autores do seed já tinham reels). */
  reels: number;
  /** Notificações criadas nesta execução (Fase 6; 0 se já existiam). */
  notifications: number;
}

/**
 * Cria as personas que ainda não existem, com a mesma senha e o e-mail já confirmado, e os
 * relacionamentos, posts, curtidas e comentários do seed (A-08), mais o bloqueio e a denúncia de
 * exemplo (Fase 3). Idempotente: rodar de novo não duplica nada nem altera o que já existe (os
 * posts só são criados para as personas que ainda não têm nenhum).
 */
export async function seedDatabase(
  db: DbExecutor,
  options: { passwordHash: string; now: Date },
): Promise<SeedResult> {
  const handles = PERSONAS.map((persona) => persona.handle);
  const existing = await db
    .select({ handle: users.handle })
    .from(users)
    .where(inArray(users.handle, handles));
  const taken = new Set(existing.map((row) => row.handle));
  const missing = PERSONAS.filter((persona) => !taken.has(persona.handle));

  if (missing.length > 0) {
    await db
      .insert(users)
      .values(
        missing.map((persona) => ({
          ...persona,
          passwordHash: options.passwordHash,
          emailVerifiedAt: options.now,
          createdAt: options.now,
          updatedAt: options.now,
        })),
      )
      .onConflictDoNothing();
  }

  const rows = await db
    .select({ id: users.id, handle: users.handle })
    .from(users)
    .where(inArray(users.handle, handles));
  const idOf = new Map(rows.map((row) => [row.handle, row.id]));
  const id = (handle: string): string => {
    const value = idOf.get(handle);
    if (value === undefined) {
      throw new Error(`seed: persona @${handle} não encontrada`);
    }
    return value;
  };

  await db
    .insert(connections)
    .values(
      SEED_CONNECTIONS.map(([first, second]) => {
        const [userAId, userBId] = [id(first), id(second)].sort();
        return { userAId: userAId ?? '', userBId: userBId ?? '', method: 'ble' as const };
      }),
    )
    .onConflictDoNothing();
  await db
    .insert(follows)
    .values(
      SEED_FOLLOWS.map(([person, creator]) => ({ followerId: id(person), creatorId: id(creator) })),
    )
    .onConflictDoNothing();
  // Bloquear desfaz conexão e follows do par (a API faz o mesmo na transação do bloqueio).
  await db
    .insert(blocks)
    .values(
      SEED_BLOCKS.map(([blocker, blocked]) => ({ blockerId: id(blocker), blockedId: id(blocked) })),
    )
    .onConflictDoNothing();
  await db
    .insert(reports)
    .values(
      SEED_REPORTS.map((report) => ({
        reporterId: id(report.reporter),
        targetType: 'account' as const,
        targetUserId: id(report.account),
        reason: report.reason,
        details: report.details,
        createdAt: options.now,
      })),
    )
    .onConflictDoNothing();

  // Posts só para as personas que ainda não têm nenhum (rodar de novo não duplica nada; uma base
  // da Fase 2 ganha só os posts das personas novas).
  const withPosts = await db
    .selectDistinct({ authorId: posts.authorId })
    .from(posts)
    .where(inArray(posts.authorId, [...idOf.values()]));
  const authorsWithPosts = new Set(withPosts.map((row) => row.authorId));
  const postsCreated = await seedPosts(
    db,
    id,
    options.now,
    SEED_POSTS.filter((seed) => !authorsWithPosts.has(id(seed.author))),
  );

  // Reels (Fase 5) só para os autores que ainda não têm nenhum: uma base das Fases 2 a 4 ganha os
  // reels sem duplicar os outros posts; rodar de novo não faz nada.
  const withReels = await db
    .selectDistinct({ authorId: posts.authorId })
    .from(posts)
    .where(and(inArray(posts.authorId, [...idOf.values()]), eq(posts.type, 'reel')));
  const authorsWithReels = new Set(withReels.map((row) => row.authorId));
  const reelsCreated = await seedReels(
    db,
    id,
    options.now,
    SEED_REELS.filter((seed) => !authorsWithReels.has(id(seed.author))),
  );

  // Notificações (Fase 6), derivadas das curtidas, comentários, conexões e follows entre as
  // personas: idempotente por linha (rodar de novo, ou numa base das Fases 2 a 5, só cria o que
  // falta).
  const notificationsCreated = await seedNotifications(db, [...idOf.values()], options.now);

  return {
    created: missing.map((persona) => persona.handle),
    skipped: handles.filter((handle) => taken.has(handle)),
    posts: postsCreated,
    reels: reelsCreated,
    notifications: notificationsCreated,
  };
}

async function seedReels(
  db: DbExecutor,
  id: (handle: string) => string,
  now: Date,
  toCreate: readonly SeedReel[],
): Promise<number> {
  for (const seed of toCreate) {
    const at = minutesBefore(now, seed.minutesAgo);
    const postId = randomUUID();
    const mediaId = randomUUID();
    const authorId = id(seed.author);
    await db.insert(posts).values({
      id: postId,
      authorId,
      type: 'reel',
      status: 'published',
      caption: seed.caption,
      createdAt: at,
      publishedAt: at,
    });
    const incomingKey = `incoming/${authorId}/${mediaId}`;
    await db.insert(postMedia).values({
      id: mediaId,
      postId,
      position: 0,
      kind: 'video',
      mime: 'video/mp4',
      sizeBytes: 8_000_000,
      incomingKey,
      posterIncomingKey: `${incomingKey}-poster`,
      posterMime: 'image/jpeg',
      posterSizeBytes: 150_000,
      storageKey: `media/${mediaId}/video.mp4`,
      thumbKey: `media/${mediaId}/poster.jpg`,
      width: 720,
      height: 1280,
      durationS: seed.durationS,
      status: 'ready',
      createdAt: at,
      updatedAt: at,
    });
  }
  return toCreate.length;
}

/** `minutes` minutos antes de `now` (Date do JS: precisão de ms, como o CHECK de `published_at`). */
function minutesBefore(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

async function seedPosts(
  db: DbExecutor,
  id: (handle: string) => string,
  now: Date,
  toCreate: readonly SeedPost[],
): Promise<number> {
  const postIds = new Map<string, string>();
  for (const seed of toCreate) {
    const at = minutesBefore(now, seed.minutesAgo);
    const postId = randomUUID();
    postIds.set(seed.key, postId);
    const values: NewPostRow = {
      id: postId,
      authorId: id(seed.author),
      type: seed.type,
      status: 'published',
      text: seed.type === 'text' ? (seed.text ?? '') : null,
      caption: seed.type === 'photo' ? (seed.caption ?? null) : null,
      createdAt: at,
      publishedAt: at,
    };
    await db.insert(posts).values(values);
    if (seed.type === 'photo') {
      const media: NewPostMediaRow[] = Array.from({ length: seed.photos ?? 1 }, (_, position) => {
        const mediaId = randomUUID();
        return {
          id: mediaId,
          postId,
          position,
          kind: 'image',
          mime: 'image/jpeg',
          sizeBytes: 250_000,
          incomingKey: `incoming/${id(seed.author)}/${mediaId}`,
          storageKey: `media/${mediaId}/full.jpg`,
          thumbKey: `media/${mediaId}/thumb.jpg`,
          width: 1080,
          height: 1350,
          status: 'ready',
          createdAt: at,
          updatedAt: at,
        };
      });
      await db.insert(postMedia).values(media);
    }
  }

  // Curtidas e comentários só nos posts criados agora (os antigos já têm os deles).
  for (const [handle, key] of SEED_LIKES) {
    const postId = postIds.get(key);
    if (postId === undefined) {
      continue;
    }
    await db.insert(likes).values({ postId, userId: id(handle) });
    await db
      .update(posts)
      .set({ likeCount: sql`${posts.likeCount} + 1` })
      .where(eq(posts.id, postId));
  }

  const commentIds: (string | undefined)[] = [];
  for (const seed of SEED_COMMENTS) {
    const postId = postIds.get(seed.post);
    const parentId = seed.replyTo === undefined ? null : commentIds[seed.replyTo];
    if (postId === undefined || parentId === undefined) {
      commentIds.push(undefined);
      continue;
    }
    const commentId = randomUUID();
    commentIds.push(commentId);
    await db.insert(comments).values({
      id: commentId,
      postId,
      authorId: id(seed.author),
      parentId,
      body: seed.body,
      createdAt: minutesBefore(now, seed.minutesAgo),
    });
    await db
      .update(posts)
      .set({ commentCount: sql`${posts.commentCount} + 1` })
      .where(eq(posts.id, postId));
  }

  return toCreate.length;
}

/** Quantas linhas um `insert … returning 1` (num CTE `ins`) criou. */
async function countInserted(db: DbExecutor, insert: SQL): Promise<number> {
  const result = await db.execute(sql`with ins as (${insert}) select count(*)::int as n from ins`);
  return (result as { rows: { n: number }[] }).rows[0]?.n ?? 0;
}

/**
 * Notificações de exemplo (Fase 6, ADR 0011), coerentes com o que o seed já tem entre as personas:
 * - curtidas → `post_liked` para o autor (15 min depois da publicação, no máximo agora);
 * - comentários → `post_commented` para o autor do post e respostas → `comment_replied` para o
 *   autor do comentário respondido (como a API faz), na hora do comentário;
 * - conexões → `connection_created` para os dois;
 * - follows → uma linha `new_followers` por criador, anônima (sem quem seguiu), no dia de hoje.
 * Nada é criado de novo: curtidas e seguidores pelos índices únicos, o resto por `not exists`. Um
 * criador que já tem qualquer notificação de seguidores não ganha outra.
 */
async function seedNotifications(
  db: DbExecutor,
  personaIds: readonly string[],
  now: Date,
): Promise<number> {
  if (personaIds.length === 0) {
    return 0;
  }
  const personas = sql`(${sql.join(
    personaIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
  const at = sql`${now.toISOString()}::timestamptz`;
  let created = 0;

  created += await countInserted(
    db,
    sql`insert into notifications (recipient_id, type, actor_id, post_id, created_at, updated_at)
        select p.author_id, 'post_liked', l.user_id, p.id,
               least(p.published_at + interval '15 minutes', ${at}),
               least(p.published_at + interval '15 minutes', ${at})
          from likes l
          join posts p on p.id = l.post_id
         where p.author_id in ${personas} and l.user_id in ${personas}
           and l.user_id <> p.author_id
           and p.status = 'published' and p.deleted_at is null
        on conflict (recipient_id, actor_id, post_id) where type = 'post_liked' do nothing
        returning 1`,
  );

  created += await countInserted(
    db,
    sql`insert into notifications
          (recipient_id, type, actor_id, post_id, comment_id, created_at, updated_at)
        select p.author_id, 'post_commented', c.author_id, p.id, c.id,
               date_trunc('milliseconds', c.created_at), date_trunc('milliseconds', c.created_at)
          from comments c
          join posts p on p.id = c.post_id
          left join comments parent on parent.id = c.parent_id
         where p.author_id in ${personas} and c.author_id in ${personas}
           and c.author_id <> p.author_id
           and (parent.id is null or parent.author_id <> p.author_id)
           and c.deleted_at is null and p.deleted_at is null
           and not exists (
             select 1 from notifications n
              where n.comment_id = c.id and n.recipient_id = p.author_id
                and n.type = 'post_commented')
        returning 1`,
  );

  created += await countInserted(
    db,
    sql`insert into notifications
          (recipient_id, type, actor_id, post_id, comment_id, created_at, updated_at)
        select parent.author_id, 'comment_replied', c.author_id, c.post_id, c.id,
               date_trunc('milliseconds', c.created_at), date_trunc('milliseconds', c.created_at)
          from comments c
          join comments parent on parent.id = c.parent_id
          join posts p on p.id = c.post_id
         where parent.author_id in ${personas} and c.author_id in ${personas}
           and c.author_id <> parent.author_id
           and c.deleted_at is null and parent.deleted_at is null and p.deleted_at is null
           and not exists (
             select 1 from notifications n
              where n.comment_id = c.id and n.recipient_id = parent.author_id
                and n.type = 'comment_replied')
        returning 1`,
  );

  created += await countInserted(
    db,
    sql`insert into notifications (recipient_id, type, actor_id, created_at, updated_at)
        select pair.recipient_id, 'connection_created', pair.actor_id,
               least(date_trunc('milliseconds', c.created_at), ${at}),
               least(date_trunc('milliseconds', c.created_at), ${at})
          from connections c
          cross join lateral (values (c.user_a_id, c.user_b_id), (c.user_b_id, c.user_a_id))
            as pair(recipient_id, actor_id)
         where c.user_a_id in ${personas} and c.user_b_id in ${personas}
           and not exists (
             select 1 from notifications n
              where n.type = 'connection_created'
                and n.recipient_id = pair.recipient_id and n.actor_id = pair.actor_id)
        returning 1`,
  );

  created += await countInserted(
    db,
    sql`insert into notifications (recipient_id, type, count, bucket_key, created_at, updated_at)
        select f.creator_id, 'new_followers', count(*)::int,
               'nf:' || to_char(${at} at time zone 'America/Sao_Paulo', 'YYYY-MM-DD'),
               ${at}, ${at}
          from follows f
         where f.creator_id in ${personas} and f.follower_id in ${personas}
           and not exists (
             select 1 from notifications n
              where n.recipient_id = f.creator_id and n.type = 'new_followers')
         group by f.creator_id
        on conflict (recipient_id, bucket_key) where bucket_key is not null do nothing
        returning 1`,
  );

  return created;
}
