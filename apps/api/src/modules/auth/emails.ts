import type { EmailMessage } from '../../infra/email/email-sender.js';

/**
 * Link do e-mail: o deep link do app (`sussurro://verificar-email?token=…`) ou, com um domínio em
 * `EMAIL_LINK_BASE_URL`, `https://…/verificar-email?token=…`. As rotas existem no app (Expo Router).
 */
export function emailLink(baseUrl: string, path: string, token: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}${path}?token=${encodeURIComponent(token)}`;
}

export const EMAIL_PATHS = {
  verifyEmail: 'verificar-email',
  resetPassword: 'redefinir-senha',
} as const;

export function verificationEmail(to: string, name: string, link: string): EmailMessage {
  return {
    to,
    link,
    subject: 'Confirme seu e-mail no Sussurro',
    text: [
      `Oi, ${name}!`,
      '',
      'Confirme que este e-mail é seu abrindo o link abaixo no celular onde o Sussurro está instalado:',
      link,
      '',
      'O link vale por 24 horas. Se você não criou uma conta no Sussurro, ignore este e-mail.',
    ].join('\n'),
  };
}

export function passwordResetEmail(to: string, name: string, link: string): EmailMessage {
  return {
    to,
    link,
    subject: 'Redefinir sua senha do Sussurro',
    text: [
      `Oi, ${name}!`,
      '',
      'Recebemos um pedido para redefinir a senha da sua conta. Abra o link abaixo no celular onde o Sussurro está instalado:',
      link,
      '',
      'O link vale por 1 hora e só funciona uma vez. Ao trocar a senha, você sai de todos os aparelhos.',
      'Se não foi você, ignore este e-mail: sua senha continua a mesma.',
    ].join('\n'),
  };
}
