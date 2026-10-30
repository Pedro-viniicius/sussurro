export interface EmailMessage {
  to: string;
  subject: string;
  /** Corpo em texto puro (pt-BR). */
  text: string;
  /** Link principal do e-mail. O adaptador de log o mostra numa linha própria. */
  link?: string;
}

/**
 * Porta de envio de e-mail (D6). Adaptadores: `LogEmailSender` (dev e testes, escreve no log) e
 * `SesEmailSender` (produção, AWS SES). Escolhido por `EMAIL_SENDER`.
 */
export abstract class EmailSender {
  abstract send(message: EmailMessage): Promise<void>;
}
