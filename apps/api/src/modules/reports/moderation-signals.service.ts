import { Injectable, Logger } from '@nestjs/common';

import { proximityAbuseEmail } from './moderation-email.js';
import { DEV_MODERATION_EMAIL } from './reports.service.js';
import { Clock } from '../../common/clock/clock.js';
import { describeError } from '../../common/errors/describe-error.js';
import { AppConfig } from '../../config/config.module.js';
import { EmailSender } from '../../infra/email/email-sender.js';
import type { ProximityAbuseFlag } from '../proximity/proximity.service.js';
import { UsersService } from '../users/users.service.js';

/**
 * Sinais automáticos para a fila de moderação mínima (X.1), além das denúncias. Hoje, só o do
 * Conectar (ADR 0012, A2-3): uma conta que fez, ou recebeu, 3 bloqueios até 60 s depois de um
 * encosto, em 7 dias (A2 rev. 1, R1-6: bloqueios, não pessoas; um por encosto e por sentido). Vai
 * para `MODERATION_EMAIL`, pela mesma porta `EmailSender` das denúncias, sem ação automática.
 */
@Injectable()
export class ModerationSignalsService {
  private readonly logger = new Logger(ModerationSignalsService.name);
  private readonly moderationAddress: string;

  constructor(
    private readonly users: UsersService,
    private readonly sender: EmailSender,
    private readonly clock: Clock,
    config: AppConfig,
  ) {
    this.moderationAddress = config.env.MODERATION_EMAIL ?? DEV_MODERATION_EMAIL;
  }

  /**
   * Um e-mail por sinal, com o @ da conta sinalizada e o papel (nunca o @ da outra parte). Conta
   * já excluída: sem e-mail (não há conta para moderar). **Nunca lança** e não espera o envio: quem
   * chama é o bloqueio, que não pode falhar por causa do sinal; a falha vai só para o log.
   */
  async proximityBlockAfterTouch(flag: ProximityAbuseFlag): Promise<void> {
    try {
      const account = await this.users.findActiveAccountById(flag.userId);
      if (account === undefined) {
        return;
      }
      const message = proximityAbuseEmail(this.moderationAddress, {
        accountHandle: account.handle,
        role: flag.role,
        detectedAt: this.clock.now(),
      });
      void this.sender.send(message).catch((error: unknown) => {
        this.logger.error(
          `Falha ao enviar o sinal do Conectar à moderação: ${describeError(error)}`,
        );
      });
    } catch (error) {
      this.logger.error(`Sinal do Conectar não montado: ${describeError(error)}`);
    }
  }
}
