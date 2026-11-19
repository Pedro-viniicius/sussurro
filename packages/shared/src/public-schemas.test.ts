// [PERM-11] Snapshot dos schemas públicos de resposta (ADR 0004, história 3.7 CA6). Toda resposta
// que mostra dados de outra conta passa por estes schemas; o interceptor da API descarta o que não
// estiver neles. Um campo novo faz este teste falhar até o snapshot ser revisto no PR.
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import {
  ConnectionRequestSchema,
  IncomingConnectionRequestsSchema,
  SimulatedConnectionRequestSchema,
} from './connections.ts';
import { FeedPageSchema } from './feed.ts';
import { NotificationsPageSchema, UnreadNotificationsSchema } from './notifications.ts';
import { CommentsPageSchema, PostSchema, ProfilePostsPageSchema } from './posts.ts';
import { ProximityResolveResultSchema, ProximityTokenSchema } from './proximity.ts';
import {
  BlocksPageSchema,
  ConnectionsPageSchema,
  FollowingPageSchema,
  FollowStateSchema,
} from './relations.ts';
import { CreatorSearchResultSchema } from './search.ts';
import { PublicProfileSchema } from './users.ts';

interface ZodDef {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  innerType?: z.ZodType;
  options?: z.ZodType[];
  in?: z.ZodType;
  values?: unknown[];
  entries?: Record<string, unknown>;
}

/**
 * Forma de um schema: objetos viram `{ chave: forma }` (chaves em ordem), arrays `[forma]`,
 * uniões `{ oneOf: [...] }`, e o resto o nome do tipo (`string`, `int`, `literal:x`, `enum:a|b`).
 */
function shapeOf(schema: z.ZodType): unknown {
  const def = (schema as unknown as { _zod: { def: ZodDef } })._zod.def;
  switch (def.type) {
    case 'object': {
      const shape = def.shape ?? {};
      return Object.fromEntries(
        Object.keys(shape)
          .sort()
          .map((key) => [key, shapeOf(shape[key]!)]),
      );
    }
    case 'array':
      return [shapeOf(def.element!)];
    case 'nullable':
      return { nullable: shapeOf(def.innerType!) };
    case 'optional':
      return { optional: shapeOf(def.innerType!) };
    case 'default':
      return shapeOf(def.innerType!);
    case 'pipe':
      return shapeOf(def.in!);
    case 'union':
      return { oneOf: (def.options ?? []).map((option) => shapeOf(option)) };
    case 'literal':
      return `literal:${(def.values ?? []).map(String).join('|')}`;
    case 'enum':
      return `enum:${Object.keys(def.entries ?? {}).join('|')}`;
    case 'number':
      return 'number';
    default:
      return def.type;
  }
}

const AUTHOR = {
  accountType: 'enum:personal|creator',
  avatarUrl: { nullable: 'string' },
  handle: 'string',
  name: 'string',
};

const POST = {
  author: AUTHOR,
  caption: { nullable: 'string' },
  commentCount: 'number',
  createdAt: 'string',
  id: 'string',
  isOwn: 'boolean',
  likeCount: 'number',
  likedByMe: 'boolean',
  // Fase 5 (revisto no PR dos reels): `kind` e `durationS` do vídeo. Nada da conta nem do arquivo
  // original (tamanho, tipo, chaves do S3, id do job do MediaConvert) sai na resposta.
  media: [
    {
      durationS: { nullable: 'number' },
      height: { nullable: 'number' },
      id: 'string',
      kind: 'enum:image|video',
      position: 'number',
      status: 'enum:pending_upload|processing|ready|failed',
      thumbUrl: { nullable: 'string' },
      url: { nullable: 'string' },
      width: { nullable: 'number' },
    },
  ],
  publishedAt: { nullable: 'string' },
  status: 'enum:draft|processing|published|failed',
  text: { nullable: 'string' },
  type: 'enum:photo|text|reel',
};

const COMMENT = {
  author: { ...AUTHOR, profileVisible: 'boolean' },
  body: 'string',
  canDelete: 'boolean',
  createdAt: 'string',
  id: 'string',
  parentId: { nullable: 'string' },
};

const OWN_LIST_PAGE = {
  items: [{ avatarUrl: { nullable: 'string' }, handle: 'string', name: 'string', since: 'string' }],
  nextCursor: { nullable: 'string' },
};

describe('[PERM-11] snapshot dos schemas públicos de resposta', () => {
  it('perfil: só números em counts; criador com followedByMe; nenhuma lista nem id', () => {
    const profileBase = {
      avatarUrl: { nullable: 'string' },
      bio: { nullable: 'string' },
      handle: 'string',
      name: 'string',
    };
    expect(shapeOf(PublicProfileSchema)).toEqual({
      oneOf: [
        {
          ...profileBase,
          accountType: 'literal:personal',
          counts: { connections: 'number', creators: 'number', posts: 'number' },
        },
        {
          ...profileBase,
          accountType: 'literal:creator',
          counts: { followers: 'number', posts: 'number' },
          followedByMe: 'boolean',
        },
      ],
    });
  });

  it('post, feed e abas do perfil: autor sem id; só likeCount e likedByMe (PERM-15)', () => {
    expect(shapeOf(PostSchema)).toEqual(POST);
    expect(shapeOf(FeedPageSchema)).toEqual({
      caughtUp: 'boolean',
      items: [POST],
      nextCursor: { nullable: 'string' },
      windowHours: 'number',
    });
    expect(shapeOf(ProfilePostsPageSchema)).toEqual({
      items: [POST],
      nextCursor: { nullable: 'string' },
    });
  });

  it('comentários: autor com profileVisible (D11), sem id da conta', () => {
    expect(shapeOf(CommentsPageSchema)).toEqual({
      items: [{ ...COMMENT, replies: [COMMENT] }],
      nextCursor: { nullable: 'string' },
    });
  });

  it('busca (BUS-10): @, nome, avatar, número de seguidores e followedByMe', () => {
    expect(shapeOf(CreatorSearchResultSchema)).toEqual({
      items: [
        {
          avatarUrl: { nullable: 'string' },
          followedByMe: 'boolean',
          followersCount: 'number',
          handle: 'string',
          name: 'string',
        },
      ],
    });
  });

  it('seguir: só o estado, sem número nem lista de seguidores', () => {
    expect(shapeOf(FollowStateSchema)).toEqual({ following: 'boolean' });
  });

  it('listas próprias (só o dono): conexões e seguidos com @, nome, avatar e data; bloqueados só com @ e data', () => {
    expect(shapeOf(ConnectionsPageSchema)).toEqual(OWN_LIST_PAGE);
    expect(shapeOf(FollowingPageSchema)).toEqual(OWN_LIST_PAGE);
    expect(shapeOf(BlocksPageSchema)).toEqual({
      items: [{ blockedAt: 'string', handle: 'string' }],
      nextCursor: { nullable: 'string' },
    });
  });
});

describe('[PERM-11] conexão presencial (Fase 4)', () => {
  const PARTY = { avatarUrl: { nullable: 'string' }, handle: 'string', name: 'string' };
  const REQUEST = {
    createdAt: 'string',
    direction: 'enum:outgoing|incoming',
    expiresAt: 'string',
    expiresInS: 'number',
    id: 'string',
    method: 'enum:qr|nfc',
    other: PARTY,
    status: 'enum:pending|accepted|not_confirmed|declined|expired|cancelled',
  };

  it('token (ADR 0013): um token só, a validade e quando renovar (o servidor guarda só o hash)', () => {
    expect(shapeOf(ProximityTokenSchema)).toEqual({
      expiresAt: 'string',
      renewInS: 'number',
      token: 'string',
    });
  });

  it('resolve (QR e NFC): @, nome, avatar, o token e alreadyConnected; sem id, sem lista de relações', () => {
    const CARD = { ...PARTY, alreadyConnected: 'boolean', token: 'string' };
    expect(shapeOf(ProximityResolveResultSchema)).toEqual({ items: [CARD] });
  });

  it('pedido: só a outra pessoa do pedido (sem id de conta) e o estado visto por quem chama', () => {
    expect(shapeOf(ConnectionRequestSchema)).toEqual(REQUEST);
    expect(shapeOf(IncomingConnectionRequestsSchema)).toEqual({ items: [REQUEST] });
    expect(shapeOf(SimulatedConnectionRequestSchema)).toEqual({
      observedToken: 'string',
      request: REQUEST,
    });
  });
});

describe('[PERM-11] notificações (Fase 6)', () => {
  const ACTOR = { ...AUTHOR, profileVisible: 'boolean' };
  const NOTIFICATION_POST = {
    id: 'string',
    thumbUrl: { nullable: 'string' },
    type: 'enum:photo|text|reel',
  };
  const BASE = { createdAt: 'string', id: 'string', read: 'boolean', updatedAt: 'string' };

  it('lista: quem agiu (sem id de conta), o post com a miniatura e o trecho; seguidores só com o número', () => {
    expect(shapeOf(NotificationsPageSchema)).toEqual({
      items: [
        {
          oneOf: [
            { ...BASE, actor: ACTOR, post: NOTIFICATION_POST, type: 'literal:post_liked' },
            {
              ...BASE,
              actor: ACTOR,
              excerpt: 'string',
              post: NOTIFICATION_POST,
              type: 'literal:post_commented',
            },
            {
              ...BASE,
              actor: ACTOR,
              excerpt: 'string',
              post: NOTIFICATION_POST,
              type: 'literal:comment_replied',
            },
            { ...BASE, actor: ACTOR, type: 'literal:connection_created' },
            // NOT-02: nenhum campo de quem seguiu (nem actor, nem lista, nem id).
            { ...BASE, count: 'number', type: 'literal:new_followers' },
          ],
        },
      ],
      nextCursor: { nullable: 'string' },
    });
  });

  it('ponto azul: só o número', () => {
    expect(shapeOf(UnreadNotificationsSchema)).toEqual({ count: 'number' });
  });
});
