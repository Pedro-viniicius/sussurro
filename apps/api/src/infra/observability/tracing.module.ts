import {
  type CallHandler,
  type ExecutionContext,
  Global,
  Injectable,
  Module,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

import { Tracing } from './tracing.js';
import { AppConfig } from '../../config/config.module.js';

/**
 * Span por requisição HTTP (6.8), com a rota (template, sem ids) e o método. Desligado
 * (`OTEL_ENABLED=false`), só repassa.
 */
@Injectable()
export class HttpTracingInterceptor implements NestInterceptor {
  constructor(private readonly tracing: Tracing) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.tracing.enabled || context.getType() !== 'http') {
      return next.handle();
    }
    const request = context.switchToHttp().getRequest<Request>();
    const route = (request.route as { path?: unknown } | undefined)?.path;
    const template = typeof route === 'string' ? route : 'desconhecida';
    return this.tracing.observe(
      `HTTP ${request.method} ${template}`,
      { 'http.request.method': request.method, 'http.route': template },
      () => next.handle(),
    );
  }
}

/** `Tracing` para a API inteira (fila push, interceptor HTTP). */
@Global()
@Module({
  providers: [
    {
      provide: Tracing,
      inject: [AppConfig],
      useFactory: ({ env }: AppConfig) => new Tracing(env.OTEL_ENABLED, 'sussurro-api'),
    },
  ],
  exports: [Tracing],
})
export class TracingModule {}
