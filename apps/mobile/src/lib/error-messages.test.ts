import { ErrorCode } from '@sussurro/shared';

import { ApiError, NetworkError } from './api/errors';
import { errorMessage, messageForError, OFFLINE_MESSAGE } from './error-messages';

describe('errorMessage', () => {
  it('todo código de erro do contrato tem mensagem em pt-BR', () => {
    for (const code of Object.values(ErrorCode)) {
      expect(errorMessage(code).length).toBeGreaterThan(0);
    }
  });

  it('mensagens globais do ux.md §5.4', () => {
    expect(errorMessage('INTERNAL_ERROR')).toBe('Algo deu errado do nosso lado. Tente de novo.');
    expect(errorMessage('RATE_LIMITED')).toBe(
      'Muitas tentativas. Espere um pouco e tente de novo.',
    );
    expect(errorMessage('ACCOUNT_TYPE_NOT_ALLOWED')).toBe(
      'Essa ação não está disponível para o seu tipo de conta.',
    );
  });

  it('[AUTH-14] a tela mostra o texto do ux.md, nunca o code técnico', () => {
    expect(messageForError(new ApiError(401, 'INVALID_CREDENTIALS', 'x'))).toBe(
      'E-mail ou senha incorretos.',
    );
    expect(messageForError(new NetworkError())).toBe(OFFLINE_MESSAGE);
    expect(messageForError(new Error('boom'))).toBe(
      'Algo deu errado do nosso lado. Tente de novo.',
    );
    for (const code of Object.values(ErrorCode)) {
      expect(errorMessage(code)).not.toContain(code);
    }
  });
});
