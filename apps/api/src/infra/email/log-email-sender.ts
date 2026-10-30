import { Logger } from '@nestjs/common';

import { EmailSender, type EmailMessage } from './email-sender.js';

/**
 * Adaptador de desenvolvimento: não envia nada, escreve o e-mail no log (o link de verificação ou
 * de redefinição aparece ali). Proibido em produção (validação do env).
 */
export class LogEmailSender extends EmailSender {
  constructor(private readonly logger: Pick<Logger, 'log'> = new Logger('Email')) {
    super();
  }

  send(message: EmailMessage): Promise<void> {
    const link = message.link === undefined ? '' : ` · link: ${message.link}`;
    this.logger.log(`E-mail (dev) para ${message.to}: "${message.subject}"${link}`);
    return Promise.resolve();
  }
}
