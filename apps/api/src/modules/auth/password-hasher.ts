import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { normalizePassword } from '@sussurro/shared';

/**
 * argon2id com os parâmetros mínimos da OWASP (m = 19 MiB, t = 2, p = 1). O argon2id é o
 * algoritmo padrão do `@node-rs/argon2` (o teste confere o prefixo `$argon2id$`).
 */
export const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Hash e verificação de senha, sempre depois do NFC (A-28). */
@Injectable()
export class PasswordHasher {
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(normalizePassword(password), ARGON2_OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, normalizePassword(password));
    } catch {
      // Hash corrompido ou em formato desconhecido: tratado como senha errada.
      return false;
    }
  }

  /**
   * Mesmo custo de uma verificação real, para e-mail inexistente: o login responde no mesmo tempo
   * com e sem conta (AUTH-06). Sempre falso.
   */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.dummyHash ??= this.hash(randomBytes(16).toString('hex'));
    await this.verify(await this.dummyHash, password);
    return false;
  }
}
