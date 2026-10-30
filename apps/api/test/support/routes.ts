import { type INestApplication, RequestMethod, type Type } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer } from '@nestjs/core';
import type { AccountType } from '@sussurro/shared';
import type { z } from 'zod';

import { IS_PUBLIC, REQUIRED_ACCOUNT_TYPE } from '../../src/common/auth/decorators.js';
import { RESPONSE_SCHEMA } from '../../src/common/http/response-schema.js';

export interface RegisteredRoute {
  method: string;
  /** Caminho com o prefixo `/v1` (exceto o health), ex.: `/v1/users/:handle`. */
  path: string;
  /** Nome da classe do módulo Nest dono do controller (ex.: `FollowsModule`). */
  module: string;
  controller: Type;
  handlerName: string;
  isPublic: boolean;
  hasResponseSchema: boolean;
  /** Schema Zod declarado em `@ResponseSchema` (PERM-09, PERM-11). */
  responseSchema: z.ZodType | undefined;
  /** Tipo de conta exigido por `@RequireAccountType` (PERM-05). */
  requiredAccountType: AccountType | undefined;
}

/** Caminhos fora do prefixo `/v1` (ver app.setup.ts). */
const UNPREFIXED = new Set(['/health', '/health/ready']);

function joinPath(...parts: string[]): string {
  const joined = parts
    .flatMap((part) => part.split('/'))
    .filter((segment) => segment !== '')
    .join('/');
  return `/${joined}`;
}

/**
 * Todas as rotas HTTP registradas no app, lidas da metadata dos controllers (o mesmo que o
 * `DiscoveryService` faria). Base do PERM-18, da regra "toda rota declara schema" (PERM-12), do
 * guard por módulo (PERM-05), do inventário (PERM-09) e do canário (PERM-10).
 */
export function listRoutes(app: INestApplication): RegisteredRoute[] {
  const routes: RegisteredRoute[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as Type | null;
      if (controller === null) {
        continue;
      }
      const controllerPath =
        (Reflect.getMetadata(PATH_METADATA, controller) as string | undefined) ?? '';
      const prototype = controller.prototype as Record<string, unknown>;
      for (const handlerName of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[handlerName];
        if (handlerName === 'constructor' || typeof handler !== 'function') {
          continue;
        }
        const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (methodPath === undefined) {
          continue;
        }
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod;
        const bare = joinPath(controllerPath, methodPath);
        const responseSchema =
          (Reflect.getMetadata(RESPONSE_SCHEMA, handler) as z.ZodType | undefined) ??
          (Reflect.getMetadata(RESPONSE_SCHEMA, controller) as z.ZodType | undefined);
        routes.push({
          method: RequestMethod[method],
          path: UNPREFIXED.has(bare) ? bare : joinPath('v1', bare),
          module: module.metatype.name,
          controller,
          handlerName,
          isPublic:
            Reflect.getMetadata(IS_PUBLIC, handler) === true ||
            Reflect.getMetadata(IS_PUBLIC, controller) === true,
          hasResponseSchema: responseSchema !== undefined,
          responseSchema,
          requiredAccountType:
            (Reflect.getMetadata(REQUIRED_ACCOUNT_TYPE, handler) as AccountType | undefined) ??
            (Reflect.getMetadata(REQUIRED_ACCOUNT_TYPE, controller) as AccountType | undefined),
        });
      }
    }
  }
  return routes;
}

/** `MÉTODO /caminho`, o nome usado nas listas revisadas dos testes. */
export function routeKey(route: Pick<RegisteredRoute, 'method' | 'path'>): string {
  return `${route.method} ${route.path}`;
}

/** Troca os parâmetros (`:handle`) por um valor de exemplo para chamar a rota. */
export function concretePath(path: string): string {
  return path.replace(/:([A-Za-z]+)/g, (_match, name: string) =>
    name === 'handle' ? 'helena' : '01a189e0-af57-7000-85fe-2054e618fea6',
  );
}
