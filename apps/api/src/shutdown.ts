import type { INestApplicationContext, LoggerService } from '@nestjs/common';

type Exit = (code: number) => void;

/**
 * Desligamento gracioso: em SIGINT/SIGTERM fecha o app (hooks onApplicationShutdown fecham
 * o pool do Postgres e o Redis) e sai com código 0. Não usamos `enableShutdownHooks()`
 * porque ele reenvia o sinal ao processo depois de fechar, e o código de saída deixa de ser 0.
 */
export function registerShutdownSignals(
  app: Pick<INestApplicationContext, 'close'>,
  logger: Pick<LoggerService, 'log' | 'error'>,
  exit: Exit = (code) => process.exit(code),
): void {
  let shuttingDown = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.log(`${signal} recebido: desligando`);
    app.close().then(
      () => {
        logger.log('Desligamento concluído');
        exit(0);
      },
      (error: unknown) => {
        logger.error(error instanceof Error ? error.stack : String(error));
        exit(1);
      },
    );
  };
  process.once('SIGINT', handler);
  process.once('SIGTERM', handler);
}
