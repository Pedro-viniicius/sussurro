import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  type CreateReportRequest,
  CreateReportRequestSchema,
  NoContentSchema,
} from '@sussurro/shared';

import { ReportsService } from './reports.service.js';
import type { AuthContext } from '../../common/auth/auth-context.js';
import { CurrentAuth } from '../../common/auth/decorators.js';
import { ResponseSchema } from '../../common/http/response-schema.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';

/** Denunciar publicação, comentário ou conta (X.1), para os dois tipos de conta. */
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Post()
  @HttpCode(202)
  @ResponseSchema(NoContentSchema)
  create(
    @CurrentAuth() auth: AuthContext,
    @Body(new ZodValidationPipe(CreateReportRequestSchema)) body: CreateReportRequest,
  ): Promise<void> {
    return this.reports.create(auth, body);
  }
}
