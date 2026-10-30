import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

import { buildLoggerParams } from './logger.options.js';
import { AppConfig } from '../../config/config.module.js';

@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => buildLoggerParams(config.env),
    }),
  ],
})
export class LoggerModule {}
