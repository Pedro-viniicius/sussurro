import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { describe, expect, it, vi } from 'vitest';

import { createEmailSender } from './email.module.js';
import { LogEmailSender } from './log-email-sender.js';
import { SesEmailSender } from './ses-email-sender.js';
import { AppConfig } from '../../config/config.module.js';
import { testEnv } from '../../testing/test-env.js';

const message = {
  to: 'ana@example.com',
  subject: 'Confirme seu e-mail no Sussurro',
  text: 'Oi!\nsussurro://verificar-email?token=abc',
  link: 'sussurro://verificar-email?token=abc',
};

describe('LogEmailSender (dev)', () => {
  it('escreve destinatário, assunto e o link no log', async () => {
    const logger = { log: vi.fn() };
    await new LogEmailSender(logger).send(message);
    expect(logger.log).toHaveBeenCalledWith(
      'E-mail (dev) para ana@example.com: "Confirme seu e-mail no Sussurro" · link: sussurro://verificar-email?token=abc',
    );
  });
});

describe('SesEmailSender (produção)', () => {
  it('manda um SendEmailCommand do SES v2 em UTF-8', async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: '1' });
    await new SesEmailSender({ send } as never, 'Sussurro <nao-responda@sussurro.app>').send(
      message,
    );
    const command = send.mock.calls[0]?.[0] as SendEmailCommand;
    expect(command).toBeInstanceOf(SendEmailCommand);
    expect(command.input).toEqual({
      FromEmailAddress: 'Sussurro <nao-responda@sussurro.app>',
      Destination: { ToAddresses: ['ana@example.com'] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: message.text, Charset: 'UTF-8' } },
        },
      },
    });
  });

  it('erro do SES propaga (o service registra e não derruba a resposta)', async () => {
    const send = vi.fn().mockRejectedValue(new Error('MessageRejected'));
    await expect(new SesEmailSender({ send } as never, 'x@y.z').send(message)).rejects.toThrow(
      'MessageRejected',
    );
  });
});

describe('createEmailSender', () => {
  it('EMAIL_SENDER escolhe o adaptador', () => {
    expect(createEmailSender(new AppConfig(testEnv()))).toBeInstanceOf(LogEmailSender);
    expect(createEmailSender(new AppConfig(testEnv({ EMAIL_SENDER: 'ses' })))).toBeInstanceOf(
      SesEmailSender,
    );
  });
});
