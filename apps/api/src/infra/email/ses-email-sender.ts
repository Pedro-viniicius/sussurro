import { SendEmailCommand, type SESv2Client } from '@aws-sdk/client-sesv2';

import { EmailSender, type EmailMessage } from './email-sender.js';

/** Adaptador de produção: AWS SES v2 (AWS SDK v3). Credenciais pela IAM role da task. */
export class SesEmailSender extends EmailSender {
  constructor(
    private readonly client: Pick<SESv2Client, 'send'>,
    private readonly from: string,
  ) {
    super();
  }

  async send(message: EmailMessage): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.from,
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: message.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: message.text, Charset: 'UTF-8' } },
          },
        },
      }),
    );
  }
}
