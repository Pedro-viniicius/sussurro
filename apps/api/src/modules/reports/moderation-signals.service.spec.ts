import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { proximityAbuseEmail } from './moderation-email.js';
import { ModerationSignalsService } from './moderation-signals.service.js';
import { DEV_MODERATION_EMAIL } from './reports.service.js';
import { AppConfig } from '../../config/config.module.js';
import type { EmailMessage } from '../../infra/email/email-sender.js';
import { FakeClock } from '../../testing/fake-clock.js';
import { testEnv } from '../../testing/test-env.js';
import type { UsersService } from '../users/users.service.js';

const M = '01a189e0-af57-7000-85fe-2054e618fe0a';

function setup(env: Record<string, string> = {}) {
  const sent: EmailMessage[] = [];
  const sender = {
    send: vi.fn((message: EmailMessage) => {
      sent.push(message);
      return Promise.resolve();
    }),
  };
  const users = {
    findActiveAccountById: vi.fn((id: string) =>
      Promise.resolve(id === M ? { id: M, handle: 'mallory' } : undefined),
    ),
  };
  const clock = new FakeClock();
  const service = new ModerationSignalsService(
    users as unknown as UsersService,
    sender,
    clock,
    new AppConfig(testEnv(env)),
  );
  return { service, sent, sender, users, clock };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ModerationSignalsService: sinal do Conectar (ADR 0012, A2-3)', () => {
  it('[PROX-55] [PROX-63] um e-mail para MODERATION_EMAIL com o @ da conta e o papel ("recebeu 3 bloqueios", nunca "3 pessoas"), sem a outra parte', async () => {
    const t = setup({ MODERATION_EMAIL: 'moderacao@sussurro.app' });
    await t.service.proximityBlockAfterTouch({ userId: M, role: 'blocked' });
    expect(t.sent).toHaveLength(1);
    const [message] = t.sent;
    expect(message!.to).toBe('moderacao@sussurro.app');
    expect(message!.subject).toBe(
      'Sinal no Conectar: @mallory recebeu 3 bloqueios logo depois de encostar',
    );
    expect(message!.text).toContain('Conta: @mallory');
    expect(message!.text).toContain(
      'Sinal: recebeu 3 bloqueios até 60 s depois de um encosto, nos últimos 7 dias.',
    );
    expect(message!.text).toContain('com blocked_id igual ao id de @mallory');
    expect(message!.text).toContain('Nenhuma ação automática');
    expect(`${message!.subject}\n${message!.text}`).not.toContain('pessoas até');
    expect(`${message!.subject}\n${message!.text}`).not.toContain('3 pessoas');
    // Só o @ da conta sinalizada (no assunto, na conta e na orientação) e nenhum id.
    expect(`${message!.subject}\n${message!.text}`.match(/@\w+/g)).toEqual([
      '@mallory',
      '@mallory',
      '@mallory',
    ]);
    expect(message!.text).not.toContain(M);
    expect(message!.link).toBeUndefined();
  });

  it('[PROX-55] [PROX-63] papel "fez" (coluna blocker_id); fora de produção sem MODERATION_EMAIL, o endereço de desenvolvimento', async () => {
    const t = setup();
    await t.service.proximityBlockAfterTouch({ userId: M, role: 'blocker' });
    expect(t.sent[0]!.to).toBe(DEV_MODERATION_EMAIL);
    expect(t.sent[0]!.subject).toBe(
      'Sinal no Conectar: @mallory fez 3 bloqueios logo depois de encostar',
    );
    expect(t.sent[0]!.text).toContain(
      'Sinal: fez 3 bloqueios até 60 s depois de um encosto, nos últimos 7 dias.',
    );
    expect(t.sent[0]!.text).toContain('com blocker_id igual ao id de @mallory');
  });

  it('[PROX-55] conta já excluída: sem e-mail', async () => {
    const t = setup();
    await t.service.proximityBlockAfterTouch({ userId: 'excluida', role: 'blocked' });
    expect(t.sender.send).not.toHaveBeenCalled();
  });

  it('[PROX-55] nunca lança: o banco ou o envio falhando ficam só no log', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const t = setup();
    t.users.findActiveAccountById.mockRejectedValueOnce(new Error('banco fora'));
    await expect(
      t.service.proximityBlockAfterTouch({ userId: M, role: 'blocked' }),
    ).resolves.toBeUndefined();
    t.sender.send.mockRejectedValueOnce(new Error('SES fora'));
    await expect(
      t.service.proximityBlockAfterTouch({ userId: M, role: 'blocker' }),
    ).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors).toHaveBeenCalledTimes(2);
  });

  it('[PROX-55] [PROX-63] proximityAbuseEmail: o texto exato da A2 rev. 1 (R1-6), com a data do sinal e nada além do @ e do papel', () => {
    const at = new Date('2026-10-30T12:00:00.000Z');
    expect(
      proximityAbuseEmail('m@x.com', { accountHandle: 'ana', role: 'blocker', detectedAt: at }),
    ).toEqual({
      to: 'm@x.com',
      subject: 'Sinal no Conectar: @ana fez 3 bloqueios logo depois de encostar',
      text: [
        'Sinal de possível abuso no Conectar (encostar os celulares).',
        '',
        'Conta: @ana',
        'Sinal: fez 3 bloqueios até 60 s depois de um encosto, nos últimos 7 dias.',
        'Cada encosto conta no máximo um bloqueio em cada sentido, mas os 3 podem envolver a mesma pessoa, em encostos diferentes.',
        'Detectado em: 2026-10-30T12:00:00.000Z',
        '',
        'Para saber quantas pessoas: na tabela blocks, as linhas dos últimos 7 dias com blocker_id igual ao id de @ana. Um desbloqueio apaga a linha, então pode haver menos linhas do que bloqueios.',
        '',
        'Nenhuma ação automática foi tomada. Pessoas combinadas, ou uma só pessoa em encostos repetidos, podem gerar este sinal contra alguém: avalie antes de agir.',
      ].join('\n'),
    });
    expect(
      proximityAbuseEmail('m@x.com', { accountHandle: 'ana', role: 'blocked', detectedAt: at }),
    ).toEqual({
      to: 'm@x.com',
      subject: 'Sinal no Conectar: @ana recebeu 3 bloqueios logo depois de encostar',
      text: [
        'Sinal de possível abuso no Conectar (encostar os celulares).',
        '',
        'Conta: @ana',
        'Sinal: recebeu 3 bloqueios até 60 s depois de um encosto, nos últimos 7 dias.',
        'Cada encosto conta no máximo um bloqueio em cada sentido, mas os 3 podem envolver a mesma pessoa, em encostos diferentes.',
        'Detectado em: 2026-10-30T12:00:00.000Z',
        '',
        'Para saber quantas pessoas: na tabela blocks, as linhas dos últimos 7 dias com blocked_id igual ao id de @ana. Um desbloqueio apaga a linha, então pode haver menos linhas do que bloqueios.',
        '',
        'Nenhuma ação automática foi tomada. Pessoas combinadas, ou uma só pessoa em encostos repetidos, podem gerar este sinal contra alguém: avalie antes de agir.',
      ].join('\n'),
    });
  });
});
