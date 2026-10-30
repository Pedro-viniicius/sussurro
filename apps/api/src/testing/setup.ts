import { Logger } from '@nestjs/common';

// Os testes verificam o comportamento, não o log: silencia o logger padrão do Nest.
Logger.overrideLogger(false);
