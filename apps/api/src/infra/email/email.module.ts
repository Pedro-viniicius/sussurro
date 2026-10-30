import { SESv2Client } from '@aws-sdk/client-sesv2';
import { Global, Module } from '@nestjs/common';

import { EmailSender } from './email-sender.js';
import { LogEmailSender } from './log-email-sender.js';
import { SesEmailSender } from './ses-email-sender.js';
import { AppConfig } from '../../config/config.module.js';

/** Escolhe o adaptador de e-mail por `EMAIL_SENDER` (D6). Sem container novo no compose. */
export function createEmailSender(config: AppConfig): EmailSender {
  const { env } = config;
  switch (env.EMAIL_SENDER) {
    case 'ses':
      return new SesEmailSender(new SESv2Client({ region: env.AWS_REGION }), env.EMAIL_FROM);
    case 'log':
      return new LogEmailSender();
  }
}

@Global()
@Module({
  providers: [{ provide: EmailSender, inject: [AppConfig], useFactory: createEmailSender }],
  exports: [EmailSender],
})
export class EmailModule {}
