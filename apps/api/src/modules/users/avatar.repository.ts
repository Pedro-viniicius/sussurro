import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  avatarUploads,
  type AvatarUploadRow,
  type DbHandle,
  eq,
  isNull,
  users,
} from '@sussurro/db';

import { DATABASE } from '../../infra/database/database.providers.js';

export interface NewAvatarUpload {
  id: string;
  userId: string;
  mime: string;
  sizeBytes: number;
  incomingKey: string;
  now: Date;
}

/** Trocas de foto de perfil (`avatar_uploads`) e a foto atual (`users.avatar_key`). */
@Injectable()
export class AvatarRepository {
  constructor(@Inject(DATABASE) private readonly database: DbHandle) {}

  async insert(upload: NewAvatarUpload): Promise<void> {
    await this.database.db.insert(avatarUploads).values({
      id: upload.id,
      userId: upload.userId,
      mime: upload.mime,
      sizeBytes: upload.sizeBytes,
      incomingKey: upload.incomingKey,
      createdAt: upload.now,
      updatedAt: upload.now,
    });
  }

  async find(id: string): Promise<AvatarUploadRow | undefined> {
    const [row] = await this.database.db
      .select()
      .from(avatarUploads)
      .where(eq(avatarUploads.id, id))
      .limit(1);
    return row;
  }

  /** `pending_upload` → `processing`. `false` se outra chamada já fez a troca (idempotente). */
  async markRequested(id: string, now: Date): Promise<boolean> {
    const updated = await this.database.db
      .update(avatarUploads)
      .set({ status: 'processing', requestedAt: now, updatedAt: now })
      .where(and(eq(avatarUploads.id, id), eq(avatarUploads.status, 'pending_upload')))
      .returning({ id: avatarUploads.id });
    return updated.length > 0;
  }

  /** Desfaz o pedido quando a fila falhou: o app pode repetir o `PUT /me/avatar`. */
  async revertToPending(id: string, now: Date): Promise<void> {
    await this.database.db
      .update(avatarUploads)
      .set({ status: 'pending_upload', requestedAt: null, updatedAt: now })
      .where(and(eq(avatarUploads.id, id), eq(avatarUploads.status, 'processing')));
  }

  async currentAvatarKey(userId: string): Promise<string | null> {
    const [row] = await this.database.db
      .select({ avatarKey: users.avatarKey })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    return row?.avatarKey ?? null;
  }

  /** "Remover foto": volta às iniciais (2.4 CA2). Devolve a chave antiga, para apagar o objeto. */
  async clearAvatar(userId: string, now: Date): Promise<string | null> {
    return this.database.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ avatarKey: users.avatarKey })
        .from(users)
        .where(and(eq(users.id, userId), isNull(users.deletedAt)))
        .for('update');
      if (current?.avatarKey == null) {
        return null;
      }
      await tx.update(users).set({ avatarKey: null, updatedAt: now }).where(eq(users.id, userId));
      return current.avatarKey;
    });
  }
}
