import { Controller, Get, Header, Res } from '@nestjs/common';
import {
  type HealthLive,
  HealthLiveSchema,
  type HealthReady,
  HealthReadySchema,
} from '@sussurro/shared';
import type { Response } from 'express';

import { HealthService } from './health.service.js';
import { Public } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';

/** Fora do prefixo /v1 (ver app.setup.ts). Sem autenticação. */
@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  /** Liveness: o processo está de pé. Não toca em Postgres nem Redis. */
  @Get()
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(HealthLiveSchema)
  live(): HealthLive {
    return { status: 'ok' };
  }

  /** Readiness: 200 com Postgres e Redis `up`; 503 com qualquer um `down`. */
  @Get('ready')
  @Header('Cache-Control', 'no-store')
  @ResponseSchema(HealthReadySchema)
  async ready(@Res({ passthrough: true }) response: Response): Promise<HealthReady> {
    const result = await this.health.readiness();
    if (result.status !== 'ok') {
      response.status(503);
    }
    return result;
  }
}
