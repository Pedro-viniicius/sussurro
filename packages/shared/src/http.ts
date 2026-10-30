import { z } from 'zod';

/**
 * Schema de resposta das rotas sem corpo (204/202). Toda rota declara um schema (ADR 0004);
 * esta é a forma de dizer "não devolve nada".
 */
export const NoContentSchema = z.undefined();
