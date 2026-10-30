import { EmailSender, type EmailMessage } from '../infra/email/email-sender.js';

/** Caixa de saída dos testes: guarda os e-mails em vez de enviar. */
export class CapturingEmailSender extends EmailSender {
  readonly sent: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }

  clear(): void {
    this.sent.length = 0;
  }

  /** Último e-mail para o endereço, ou falha o teste. */
  lastTo(email: string): EmailMessage {
    const found = this.sent.filter((message) => message.to === email).at(-1);
    if (found === undefined) {
      throw new Error(`Nenhum e-mail para ${email}`);
    }
    return found;
  }

  /** Token do link do e-mail (`...?token=`). */
  static tokenOf(message: EmailMessage): string {
    const token =
      message.link === undefined ? null : new URL(message.link).searchParams.get('token');
    if (token === null) {
      throw new Error(`E-mail sem token: ${message.subject}`);
    }
    return token;
  }
}
