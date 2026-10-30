# Plano da Fase 0: fundação do monorepo

> Autor: Dev (full stack). Data: 2026-10-29. Status: **implementado em 2026-10-29** (aprovado pelo PO; divergências na §12.1; pendências de ambiente no `README.md`, "Estado das fases").
> Entradas: `briefing.md` §5, §6 e §8, `arquitetura.md`, ADRs 0001 a 0011. Este plano depende de `ux.md` (design system, do UX/UI) e de `infra.md` (docker-compose, CI, EAS e instalação do pnpm, do DevOps). Os dois ainda estavam em elaboração quando este plano foi escrito.

## 1. Objetivo e escopo

**Objetivo**: deixar o repositório pronto para as Fases 1 a 7. Um comando instala, faz lint, typecheck, testes e build. A API e o worker sobem contra Postgres e Redis locais. O app abre num dev build no Android e no iOS e mostra a marca e o catálogo dos componentes base.

Texto da especificação (§8): *"monorepo, docker-compose, lint e testes rodando, CI básico, tema e componentes base em packages/ui com uma tela de catálogo dos componentes."*

### Entra na Fase 0

| Item | Responsável |
|---|---|
| Monorepo pnpm + Turborepo, configs da raiz, `packages/config` | Dev |
| Portão do ADR 0001: smoke test do Node 26 + Expo + pnpm isolado no Windows | Dev |
| `packages/shared` com o contrato de erro (`ErrorResponse`, `ErrorCode`) e o schema de health | Dev |
| `packages/db` com config do Drizzle, cliente e conexão (**sem tabelas**, ver §2.6) | Dev |
| `apps/api`: bootstrap NestJS 12 (ESM), config validada por Zod, logger pino, filtro global de erros, `GET /health` e `GET /health/ready` (Postgres + Redis), testes | Dev |
| `apps/worker`: application context NestJS, config, logger, desligamento gracioso, teste | Dev |
| `apps/mobile`: Expo SDK 58 + Expo Router, fontes, ícone e splash a partir do `<Logo>`, tela inicial provisória, rota `/dev/catalog` só em dev, Jest | Dev |
| `packages/ui`: `theme.ts` (tokens do PO + extensões do `ux.md`), `<Logo>` e componentes **base** (ver §1.1), com testes | Dev (spec: UX) |
| Sentry mínimo: SDK inicializado só quando houver DSN (**decisão do PO**, §10) | Dev |
| docker-compose (Postgres, Redis, emuladores S3/SQS) e CI básico | **DevOps**, ver `infra.md` |
| Spike dos emuladores S3/SQS (ADR 0010: PUT pré-assinado, HEAD, DLQ) | DevOps + Dev |
| Dev builds EAS (Android e iOS) instalados em aparelho | Dev + PO (contas) |
| README da raiz, template de PR, convenções de commit | Dev |

### 1.1 "Componentes base": interpretação a confirmar com o PO

A especificação lista 15 componentes. Proponho dividir:

| Fase 0 (base, sem dados de domínio) | Fase em que nascem (compostos, dependem de dados ou de libs da fase) |
|---|---|
| `Logo` (mark/lockup), `Icon` (wrapper da biblioteca escolhida no `ux.md`), `Avatar`, `Button`, `Input`, `TopTabs`, `BottomTabBar`, `Toast`, `EmptyState`, `CaughtUp`, `StatsRow` | `PostPhoto`, `PostText`, `CommentsSheet` (Fase 2); `ProfileHeader` (Fase 1, usado no perfil próprio); `ReelTile`, `ReelViewer` (Fase 5, dependem de `expo-video`) |

Motivo: os compostos dependem de contratos de API e de libs (vídeo, folha inferior, carrossel) que ainda não existem. Construí-los agora geraria retrabalho. Todos entram no catálogo quando forem criados.

### Fica explicitamente para as próximas fases

- Qualquer tabela, migration ou seed de domínio (Fase 1 em diante).
- Autenticação, cliente HTTP do app, telas de login e cadastro, navegação por tipo de conta (Fase 1).
- Interceptor de resposta por schema Zod (ADR 0004): entra na Fase 1, junto com as primeiras rotas de domínio.
- Filas SQS, S3, sharp e mídia no worker (Fase 2). Módulo nativo BLE (Fase 4). Push (Fase 6).
- Sentry completo: upload de source maps, releases, scrubbing de relacionamentos, alertas (Fase 6).
- Dockerfiles de produção e Terraform (Fase 7; o DevOps pode antecipar o Dockerfile se o `infra.md` pedir).

## 2. Estrutura de pastas (nível de arquivo)

Legenda: **(gerado)** = criado por ferramenta e não editado à mão; **(DevOps)** = conteúdo definido no `infra.md`; **(gitignored)** = não vai para o Git.

```
C:\dev\sussurro\
├── package.json                      # private, packageManager pnpm@12.13.0, engines, scripts da raiz
├── pnpm-workspace.yaml               # packages: apps/*, packages/*; nodeLinker, engineStrict, allowBuilds
├── pnpm-lock.yaml                    # (gerado)
├── turbo.json                        # pipeline (§4)
├── .nvmrc                            # 26.13.0
├── .npmrc                            # só registry; config de comportamento fica no pnpm-workspace.yaml
├── .editorconfig                     # utf-8, lf, 2 espaços, final newline
├── .gitignore                        # node_modules, dist, .turbo, coverage, .env*, android/, ios/, .expo/, expo-env.d.ts
├── .gitattributes                    # * text=auto eol=lf; *.ps1/*.cmd/*.bat eol=crlf; png/jpg/ttf/otf/jar binary
├── .prettierrc.json                  # endOfLine lf, singleQuote, trailingComma all, printWidth 100
├── .prettierignore                   # pnpm-lock.yaml, dist, coverage, .expo, android, ios
├── commitlint.config.mjs             # @commitlint/config-conventional + escopos (§6.4)
├── lefthook.yml                      # pre-commit: prettier + eslint nos staged; commit-msg: commitlint
├── README.md                         # pré-requisitos, setup no Windows, comandos, links para docs/equipe
├── CLAUDE.md                         # já existe (atualizado na consolidação)
├── docker-compose.yml                # (DevOps) postgres:18, valkey/redis, emuladores S3/SQS
├── .env.example                      # (DevOps) variáveis do compose
├── .vscode/
│   ├── extensions.json               # eslint, prettier, editorconfig, expo-tools
│   └── settings.json                 # formatOnSave, eslint flat config
├── .github/
│   ├── pull_request_template.md      # §6.6
│   └── workflows/ci.yml              # (DevOps)
├── docs/                             # já existe (design, equipe)
│
├── packages/
│   ├── config/
│   │   ├── package.json              # @sussurro/config; exports dos arquivos abaixo
│   │   ├── tsconfig/
│   │   │   ├── base.json             # strict + extras (§3.3)
│   │   │   ├── node-library.json     # module/moduleResolution nodenext, rewriteRelativeImportExtensions
│   │   │   ├── nest-app.json         # nodenext + experimentalDecorators + emitDecoratorMetadata
│   │   │   └── expo.json             # extends expo/tsconfig.base + customConditions + allowImportingTsExtensions
│   │   └── eslint/
│   │       ├── base.mjs              # @eslint/js + typescript-eslint strictTypeChecked + import order
│   │       ├── node.mjs              # base + regras Node/Nest
│   │       └── react-native.mjs      # base + eslint-config-expo (flat) + react-hooks
│   │
│   ├── shared/
│   │   ├── package.json              # @sussurro/shared; exports com condição @sussurro/source (§3.4)
│   │   ├── tsconfig.json             # typecheck (noEmit)
│   │   ├── tsconfig.build.json       # emite dist/ (js + d.ts)
│   │   ├── eslint.config.mjs
│   │   ├── vitest.config.ts
│   │   └── src/
│   │       ├── index.ts
│   │       ├── errors.ts             # ErrorCode (as const), ErrorResponseSchema { code, message, details? }
│   │       ├── errors.test.ts
│   │       ├── health.ts             # HealthLiveSchema, HealthReadySchema
│   │       └── health.test.ts
│   │
│   ├── db/
│   │   ├── package.json              # @sussurro/db; scripts db:generate, db:migrate, db:studio
│   │   ├── tsconfig.json
│   │   ├── tsconfig.build.json
│   │   ├── eslint.config.mjs
│   │   ├── vitest.config.ts          # unit
│   │   ├── vitest.int.config.ts      # integração (precisa do Postgres do compose)
│   │   ├── drizzle.config.ts         # dialect postgresql, schema ./src/schema, out ./migrations, DATABASE_URL
│   │   └── src/
│   │       ├── index.ts              # export { createDb, type Db } e o schema
│   │       ├── client.ts             # createDb(url, opts) -> { db, pool, close() } com node-postgres Pool
│   │       ├── client.test.ts        # opções do pool, validação da URL
│   │       ├── client.int.test.ts    # conecta e roda select 1
│   │       └── schema/
│   │           └── index.ts          # export {} ; as tabelas chegam na Fase 1
│   │
│   └── ui/
│       ├── package.json              # @sussurro/ui; só fonte TS; peers react, react-native, react-native-svg
│       ├── tsconfig.json
│       ├── eslint.config.mjs
│       ├── jest.config.js            # preset jest-expo
│       ├── jest.setup.ts
│       └── src/
│           ├── index.ts
│           ├── theme.ts              # tokens do PO (inalterados) + escalas do ux.md
│           ├── theme.test.ts         # trava os valores hex do briefing
│           ├── test-utils/render.tsx
│           └── components/
│               ├── Logo/{Logo.tsx, Logo.test.tsx, index.ts}
│               ├── Icon/{Icon.tsx, Icon.test.tsx, index.ts}
│               ├── Avatar/{Avatar.tsx, avatar-color.ts, avatar-color.test.ts, Avatar.test.tsx, index.ts}
│               ├── Button/{Button.tsx, Button.test.tsx, index.ts}
│               ├── Input/{Input.tsx, Input.test.tsx, index.ts}
│               ├── TopTabs/{TopTabs.tsx, TopTabs.test.tsx, index.ts}
│               ├── BottomTabBar/{BottomTabBar.tsx, BottomTabBar.test.tsx, index.ts}
│               ├── Toast/{Toast.tsx, ToastProvider.tsx, Toast.test.tsx, index.ts}
│               ├── EmptyState/{EmptyState.tsx, EmptyState.test.tsx, index.ts}
│               ├── CaughtUp/{CaughtUp.tsx, CaughtUp.test.tsx, index.ts}
│               └── StatsRow/{StatsRow.tsx, StatsRow.test.tsx, index.ts}
│
└── apps/
    ├── api/
    │   ├── package.json              # @sussurro/api; "type": "module"
    │   ├── nest-cli.json             # builder swc, typeCheck false (typecheck é tarefa separada)
    │   ├── .swcrc                    # legacyDecorator + decoratorMetadata, module es6
    │   ├── tsconfig.json
    │   ├── tsconfig.build.json
    │   ├── eslint.config.mjs
    │   ├── vitest.config.ts          # unit (unplugin-swc)
    │   ├── vitest.e2e.config.ts      # e2e (precisa do compose)
    │   ├── (sem .env.example: a API lê o `.env` da raiz; ver §5)
    │   ├── src/
    │   │   ├── instrument.ts         # Sentry.init só se SENTRY_DSN; carregado com node --import
    │   │   ├── main.ts               # bootstrap, prefixo /v1 (exceto /health), shutdown hooks, filtro global
    │   │   ├── app.module.ts
    │   │   ├── app.module.spec.ts    # compila o módulo; prova que a metadata de decorators é emitida
    │   │   ├── config/
    │   │   │   ├── env.schema.ts     # Zod; falha no boot com mensagem clara
    │   │   │   ├── env.schema.spec.ts
    │   │   │   └── config.module.ts
    │   │   ├── common/
    │   │   │   ├── errors/
    │   │   │   │   ├── domain-error.ts           # DomainError(code, httpStatus, message, details?)
    │   │   │   │   └── domain-error.spec.ts
    │   │   │   └── filters/
    │   │   │       ├── all-exceptions.filter.ts  # tudo vira { code, message, details? }
    │   │   │       └── all-exceptions.filter.spec.ts
    │   │   └── infra/
    │   │       ├── database/{database.module.ts, database.providers.ts}   # token DB, close no shutdown
    │   │       ├── redis/{redis.module.ts, redis.providers.ts}            # ioredis, close no shutdown
    │   │       ├── observability/logger.module.ts                         # nestjs-pino, redact de Authorization etc.
    │   │       └── health/
    │   │           ├── health.module.ts
    │   │           ├── health.controller.ts      # GET /health, GET /health/ready
    │   │           ├── health.service.ts         # checks com timeout de 1 s
    │   │           ├── health.service.spec.ts    # up/down/timeout com dublês
    │   │           └── health.controller.spec.ts # 200/503 e formato do schema
    │   └── test/
    │       └── health.e2e-spec.ts    # sobe o app real contra o compose; ready = 200
    │
    ├── worker/
    │   ├── package.json              # @sussurro/worker; "type": "module"
    │   ├── nest-cli.json
    │   ├── .swcrc
    │   ├── tsconfig.json
    │   ├── tsconfig.build.json
    │   ├── eslint.config.mjs
    │   ├── vitest.config.ts
    │   ├── (sem .env.example: o worker lê o `.env` da raiz; ver §5)
    │   └── src/
    │       ├── instrument.ts
    │       ├── main.ts               # createApplicationContext, enableShutdownHooks, SIGTERM
    │       ├── worker.module.ts
    │       ├── worker.module.spec.ts # compila; desligamento fecha os recursos
    │       └── config/{env.schema.ts, env.schema.spec.ts}
    │
    └── mobile/
        ├── package.json              # @sussurro/mobile; main expo-router/entry
        ├── app.config.ts             # nome, slug, scheme "sussurro", bundle id por APP_VARIANT, plugins
        ├── eas.json                  # perfis development/preview/production, node 26.13.0 (detalhes no infra.md)
        ├── metro.config.js           # getDefaultConfig do Expo, sem ajustes manuais (ADR 0001)
        ├── jest.config.js            # preset jest-expo
        ├── jest.setup.ts
        ├── tsconfig.json             # extends @sussurro/config/tsconfig/expo.json
        ├── eslint.config.mjs
        ├── .env.example              # EXPO_PUBLIC_SENTRY_DSN, APP_VARIANT
        ├── expo-env.d.ts             # (gerado, gitignored)
        ├── assets/images/
        │   ├── icon.png              # 1024, gerado do <Logo variant="mark">
        │   ├── adaptive-icon.png     # foreground Android
        │   ├── adaptive-icon-monochrome.png
        │   └── splash-icon.png
        ├── scripts/
        │   └── generate-icons.mjs    # SVG do logo -> PNGs (sharp); também valida sharp no Windows
        └── src/
            ├── app/
            │   ├── _layout.tsx       # carrega fontes, segura o splash, ToastProvider, Sentry
            │   ├── index.tsx         # tela provisória: lockup + tagline; link para o catálogo em dev
            │   ├── +not-found.tsx
            │   └── dev/
            │       ├── _layout.tsx   # Redirect para "/" se isDevRoutesEnabled() for falso
            │       └── catalog.tsx   # reexporta CatalogScreen
            ├── features/catalog/
            │   ├── CatalogScreen.tsx         # seções por componente, todas as variantes e estados
            │   └── CatalogScreen.test.tsx
            ├── lib/
            │   ├── dev-routes.ts             # __DEV__ || EXPO_PUBLIC_DEV_TOOLS === '1'
            │   ├── dev-routes.test.ts
            │   ├── fonts.ts                  # Inter (400/600/700) + Bricolage Grotesque 800
            │   └── sentry.ts                 # init só se EXPO_PUBLIC_SENTRY_DSN
            └── app-tests/
                └── index.test.tsx            # renderiza a tela inicial com o router de teste
```

`android/` e `ios/` não são versionados (Continuous Native Generation: `expo prebuild` e EAS geram). `apps/mobile/modules/sussurro-proximity` nasce na Fase 4 e `infra/terraform` na Fase 7.

### 2.6 Banco: a Fase 0 cria alguma tabela?

**Não.** A Fase 0 entrega só `drizzle.config.ts`, `createDb()` e a verificação `select 1` no `/health/ready`. Motivos:
- As primeiras tabelas (`users`, `refresh_tokens`, enums e o trigger `users_account_type_immutable`) pertencem à Fase 1, e criá-las agora seria antecipar escopo.
- O PostgreSQL 18 já tem `uuidv7()` nativo, então não há extensão a habilitar.
- Fica uma decisão para o início da Fase 1: **Drizzle 0.45.x (estável) ou 1.0 (RC hoje)**. O formato das migrations muda na 1.0, então é melhor escolher antes da primeira migration. Recomendação: 1.0 se tiver saído como estável até lá, senão 0.45.x.

`db:generate`, `db:migrate` e `db:studio` já existem como scripts, mas só são exercitados na Fase 1.

## 3. Ferramentas e versões

Versões consultadas no registro npm em 2026-10-29. Ficam fixadas no lockfile; `package.json` usa `^` dentro do major (exceto Expo, que usa as faixas do `expo install`).

| Ferramenta | Versão | Observação |
|---|---|---|
| Node | 26.13.0 | ADR 0001; fallback Node 24 |
| pnpm | 12.13.0 | instalado à parte (sem corepack), ver `infra.md` |
| Turborepo | 2.11.x | |
| TypeScript | **6.0.3** (não a 7.0) | ver §3.3 |
| Expo SDK | 58 (`expo` 58.0.x, `expo-router` 58.0.x, `expo-dev-client` 58.0.x) | RN 0.88.1, React 19.3.1 |
| jest-expo / Jest | 58.0.x / 30.x | |
| @testing-library/react-native | 14.1.x (usa `test-renderer` 1.x) | |
| NestJS | 12.3.x (`@nestjs/core`, `common`, `platform-express`, `testing`), CLI 12.0.x | pacotes ESM |
| Vitest | 5.0.x + `unplugin-swc` 2.0 + `@swc/core` 1.16 | ver §3.1 |
| Drizzle | `drizzle-orm` 0.45.4, `drizzle-kit` 0.31.11 (rever na Fase 1) | |
| Postgres driver | `pg` 8.23 | |
| Redis client | `ioredis` 6.0 | fallback 5.x se o major novo der problema |
| Zod | 4.6.x | contratos em `packages/shared` |
| Logger | `pino` 10 + `nestjs-pino` 5.3 (aceita Nest 12) | |
| ESLint / typescript-eslint / Prettier | 10.13 / 8.72 / 3.9 | `eslint-config-expo` 58 no app |
| Sentry | `@sentry/react-native` 8.33, `@sentry/nestjs` 11.10 | se aprovado (§10) |
| Fontes | `@expo-google-fonts/inter`, `@expo-google-fonts/bricolage-grotesque` + `expo-font` | |
| SVG | `react-native-svg` 15.16 | Logo e ícones |
| Hooks de Git | `lefthook` 2.2 + `@commitlint/cli` 21 | binário único, funciona bem no Windows |

### 3.1 Testes da API e do worker: Vitest (com SWC)

- **Vitest**, não Jest. O NestJS 12 gera projetos ESM com Vitest por padrão, a especificação aceita "Vitest/Jest", e o Vitest é mais rápido e nativo em ESM.
- **Decorators**: o Vite 8 transforma TS com Oxc. A documentação oficial do Nest (receita SWC) usa `unplugin-swc`. Vamos usar `unplugin-swc` com `legacyDecorator` e `decoratorMetadata` explícitos no `.swcrc`, porque a injeção de dependência do Nest depende de `emitDecoratorMetadata`. O teste `app.module.spec.ts` resolve providers só por tipo (sem `@Inject`): se a metadata não for emitida, ele falha. Esse é o detector.
- Plano B: Jest 30 + `@swc/jest` (projeto Nest CJS continua suportado).
- Separação: `*.spec.ts` = unitário, sem I/O, roda no `pnpm test`. `test/*.e2e-spec.ts` e `*.int.test.ts` = precisam do compose, rodam no `pnpm test:e2e` e no CI com services.

### 3.2 Testes do app e de `packages/ui`: Jest + jest-expo + Testing Library

- O Metro e o Babel do Expo não rodam no Vitest de forma suportada, e o `jest-expo` é a única opção oficial do Expo. A especificação pede Testing Library no app.
- `jest-expo` 58 já depende de `test-renderer` 1.3, que é o renderizador exigido pela RNTL 14 (o `react-test-renderer` foi descontinuado). Os peers batem com React 19.3 no papel; a confirmação é o primeiro teste rodando (risco F0-2).
- `packages/ui` usa o mesmo preset, com seu próprio `jest.config.js`, para ser testado isoladamente.

### 3.3 TypeScript

- **Versão 6.0.3, e não a 7.0** (a 7.0 é o compilador nativo em Go, lançado em jul/2026). Motivos: `typescript-eslint` 8.72 exige `typescript <6.1`, e a emissão de `emitDecoratorMetadata` no compilador nativo ainda não está confirmada. Reavaliar quando sair a 7.1 com a nova API. **Isso não diverge da especificação**, que pede só "TypeScript strict".
- `strict: true` + `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax`, `isolatedModules`.
- **Sem project references.** O Turborepo já ordena e cacheia as tarefas, e o typecheck lê o código-fonte dos pacotes internos por condição de export (§3.4), sem precisar de `.d.ts` buildados. Project references exigiriam `composite`, builds incrementais e manutenção de `references` em cada pacote, sem ganho neste tamanho de repo.

### 3.4 Como os pacotes internos são consumidos

| Pacote | Consumido por | Estratégia |
|---|---|---|
| `@sussurro/ui` | só o app (Metro, Jest) | **Só fonte TS**, sem build. `exports: { ".": "./src/index.ts", "./theme": "./src/theme.ts" }` |
| `@sussurro/shared` | app (Metro) **e** API/worker (Node ESM) | **Fonte + build**: `exports` com as condições `@sussurro/source` → `./src/index.ts`, `react-native` → `./src/index.ts`, `types` → `./dist/index.d.ts`, `default` → `./dist/index.js` |
| `@sussurro/db` | API e worker | Igual ao `shared`, sem a condição `react-native` |
| `@sussurro/config` | ferramentas | arquivos JSON/MJS exportados diretamente |

- O **Metro** já resolve a condição `react-native` e lê o fonte. O `metro.config.js` fica no padrão do Expo, sem `watchFolders`, alinhado ao ADR 0001.
- **tsc** (`customConditions: ["@sussurro/source"]`), **Vitest** (`resolve.conditions`) e **Jest** leem o fonte. Lint, typecheck e testes não precisam de build prévio.
- O **runtime Node** da API e do worker usa `dist/` (condição `default`). O `turbo build` builda os pacotes antes (`^build`). No `dev`, cada pacote roda `tsc -w`.
- Imports relativos dentro de `shared` e `db` usam a extensão `.ts` com `rewriteRelativeImportExtensions`. O build emite `.js` válido para o Node ESM, e o Metro resolve o `.ts` explícito. Isso é validado no smoke test (`expo export`).

### 3.5 Lint e formatação

- **ESLint 10 em flat config, um `eslint.config.mjs` por pacote** importando de `@sussurro/config/eslint/*`. O ESLint 10 procura a config a partir do diretório do arquivo, então cada pacote é lintado e cacheado pelo turbo separadamente.
- `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked`. No app, `eslint-config-expo` (flat) + `react-hooks`.
- Regras do projeto: `no-restricted-imports` impede o app de importar `@sussurro/db` e impede `packages/shared` de importar React ou Nest. `@typescript-eslint/no-floating-promises` e `switch-exhaustiveness-check` ficam como erro.
- **Prettier 3** formata tudo; o ESLint não tem regras de estilo (`eslint-config-prettier`).
- O NestJS 12 traz oxlint como padrão em projetos novos. **Mantemos ESLint** porque a especificação fixa "ESLint + Prettier".

### 3.6 Outras escolhas da API

- **Health próprio, sem `@nestjs/terminus`**: são duas verificações (`select 1` e `PING`) com timeout. O formato da resposta vem de um schema Zod do `shared`, o que já exercita o padrão de contrato. O terminus impõe o formato dele e não acrescenta nada aqui.
- **Validação de entrada**: o NestJS 12 aceita Standard Schema nos decorators (`@Body({ schema })`), e o Zod 4 implementa Standard Schema. Usamos o recurso nativo. Plano B: `nestjs-zod` 5.5. Na Fase 0 isso só é testado no `env.schema.ts`, porque não há rota com corpo.
- **Express** (padrão do Nest, conforme `arquitetura.md` §3).
- **Build**: `nest build` com builder SWC. O typecheck é uma tarefa separada do turbo.

## 4. Scripts da raiz e pipeline do Turborepo

### 4.1 Scripts (`package.json` da raiz)

| Script | Comando | O que faz |
|---|---|---|
| `dev` | `turbo run dev --filter=!@sussurro/mobile` | API + worker + `tsc -w` dos pacotes |
| `dev:mobile` | `pnpm --filter @sussurro/mobile start` | `expo start --dev-client` |
| `build` | `turbo run build` | pacotes + API + worker (o app não tem build local: EAS) |
| `lint` | `turbo run lint` | ESLint em todos os pacotes |
| `typecheck` | `turbo run typecheck` | `tsc --noEmit` em todos |
| `test` | `turbo run test` | unitários (sem Docker) |
| `test:e2e` | `turbo run test:e2e` | integração e e2e (precisa do compose) |
| `format` | `prettier --write .` | |
| `format:check` | `prettier --check .` | usado no CI |
| `check` | `pnpm format:check && turbo run lint typecheck test` | tudo que o CI roda, localmente |
| `db:generate` / `db:migrate` / `db:studio` | `pnpm --filter @sussurro/db <script>` | drizzle-kit (usados a partir da Fase 1) |
| `clean` | `turbo run clean && rimraf node_modules .turbo` | |

Subir e derrubar o compose fica com os scripts que o DevOps definir no `infra.md`.

### 4.2 `turbo.json`

| Tarefa | `dependsOn` | `outputs` | Cache | Observação |
|---|---|---|---|---|
| `transit` | `^transit` | – | sim | tarefa vazia: faz o hash de um pacote incluir o fonte das dependências internas |
| `build` | `^build` | `dist/**` | sim | |
| `typecheck` | `transit` | – | sim | |
| `lint` | `transit` | – | sim | |
| `test` | `transit` | `coverage/**` | sim | |
| `test:e2e` | `^build` | – | **não** | depende de serviços externos |
| `dev` | `^build` | – | não | `persistent: true` |
| `clean` | – | – | não | |

`globalDependencies`: `.nvmrc`, `packages/config/tsconfig/*.json`. `globalEnv`: `NODE_ENV`. Variáveis por tarefa (`DATABASE_URL`, `REDIS_URL`) em `env` de `test:e2e`. Os prefixos `EXPO_PUBLIC_*` não entram no cache porque o app não tem tarefa `build` no turbo.

## 5. Ambiente e configuração

- Variáveis de ambiente validadas por Zod no boot da API e do worker. Variável faltando derruba o processo com uma mensagem que diz qual faltou. Nada de defaults silenciosos para URLs de banco.
- Um `.env.example` na raiz (compose, API e worker; porta da API em `API_PORT`), mais o do app (`EXPO_PUBLIC_*`, que o Expo lê da pasta do app). Sem segredos; `.env` é ignorado no Git. Variáveis em `infra.md` §3.4. _(Padronizado na consolidação, A-25.)_
- O app em dev não chama a API na Fase 0. `EXPO_PUBLIC_API_URL` entra na Fase 1.
- `pnpm-workspace.yaml`: `nodeLinker: isolated` (padrão, ADR 0001) e a lista de pacotes com permissão para rodar scripts de instalação (o pnpm bloqueia por padrão): `@swc/core`, `esbuild`, `sharp`, `unrs-resolver` e o que o `pnpm install` acusar. Nada além do necessário.

## 6. Padrões de código e convenções

### 6.1 Nomes

| Item | Convenção | Exemplo |
|---|---|---|
| Idioma do código | inglês (identificadores, rotas, nomes de arquivo) | `connection-requests.service.ts` |
| Idioma de textos da UI e docs | português do Brasil | `"Você está em dia"` |
| Arquivos Nest | kebab-case com sufixo de papel | `health.controller.ts`, `domain-error.ts` |
| Componentes React | PascalCase, uma pasta por componente | `Button/Button.tsx` |
| Hooks | `useAlgo.ts` | `useToast.ts` |
| Rotas Expo Router | kebab-case | `src/app/dev/catalog.tsx` |
| Schemas Zod | `PascalCaseSchema` + tipo inferido sem sufixo | `ErrorResponseSchema`, `type ErrorResponse` |
| Constantes e códigos de erro | `UPPER_SNAKE_CASE` | `ACCOUNT_TYPE_NOT_ALLOWED` |
| Banco | snake_case no Postgres; camelCase no TS (o Drizzle mapeia) | `account_type` ↔ `accountType` |
| Pacotes | escopo `@sussurro/*` | `@sussurro/shared` |
| Testes | ao lado do arquivo: `.spec.ts` (Nest), `.test.ts(x)` (pacotes e app); e2e em `test/` | |

`enum` do TS proibido (usar `as const` + união): funciona igual no Metro, no SWC e no type stripping do Node.

### 6.2 Módulos NestJS

- `src/modules/<dominio>/` a partir da Fase 1, com `<dominio>.module.ts`, `.controller.ts`, `.service.ts`, `.repository.ts` (só queries Drizzle) e testes ao lado.
- `src/infra/*` para providers técnicos (database, redis, health, observability, depois queue e storage), sem regra de negócio.
- `src/common/*` para erros, filtros, interceptors, guards e decorators transversais.
- Regras de `arquitetura.md` §5: controller só fala com service do próprio módulo; leitura de relacionamento entre módulos passa pelo `AccessPolicyService`; nenhum módulo importa repository de outro. Na Fase 1 isso vira regra de lint (`no-restricted-imports` por caminho).
- Controllers finos: validam a entrada pelo schema, chamam um método do service e devolvem o DTO de resposta. Regra de negócio fica no service. Nunca no controller e nunca no app.

### 6.3 Erros e validação

- **Formato único**: `{ code: ErrorCode, message: string, details?: unknown }`, definido em `packages/shared/src/errors.ts` e usado pelo app para escolher a mensagem em pt-BR. O `message` do servidor é para log e depuração; o app não o mostra cru.
- **`DomainError`** (code, status HTTP, message, details) é a única exceção lançada por services. O `AllExceptionsFilter` converte:

| Origem | HTTP | `code` |
|---|---|---|
| `DomainError` | o da instância | o da instância |
| Falha de validação (Zod/Standard Schema) | 400 | `VALIDATION_ERROR`, com `details` = lista de `{ path, message }` |
| `HttpException` do Nest (404 de rota, 401 do guard) | o da exceção | `NOT_FOUND`, `UNAUTHORIZED` etc. |
| Erro do Postgres `23505` / `23503` (a partir da Fase 1) | 409 / 403 conforme ADR 0008 | mapeado por constraint |
| Qualquer outra coisa | 500 | `INTERNAL_ERROR`; sem stack no corpo; vai ao log e ao Sentry |

- **Zod nas bordas**: entrada HTTP (body, query, params), variáveis de ambiente, mensagens de fila (Fase 2) e respostas (interceptor do ADR 0004, Fase 1). Dentro do sistema confiamos nos tipos.
- No app (a partir da Fase 1): toda tela com dados trata os estados carregando, vazio, erro e offline, conforme o `ux.md`.

### 6.4 Conventional Commits

- Formato: `tipo(escopo): descrição no imperativo em pt-BR`. Ex.: `feat(api): adiciona verificação de Redis no /health/ready`.
- Tipos: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`, `build`, `ci`, `perf`, `style`.
- Escopos: `mobile`, `api`, `worker`, `shared`, `ui`, `db`, `config`, `infra`, `docs`, `deps`, `repo`.
- `BREAKING CHANGE:` no rodapé quando quebrar contrato da API.
- Verificado pelo commitlint no hook `commit-msg` (lefthook) e no CI.
- **Nenhum commit sem pedido explícito do PO.** O repositório ainda não tem `git init` (D16).

### 6.5 Branches

- **Trunk-based**: `main` protegida (PR obrigatório, CI verde).
- Branches curtas: `feat/f0-catalogo-ui`, `fix/api-health-timeout`, `chore/deps-expo-58-0-22`. O prefixo `fN` liga a branch à fase.
- **Squash merge**: um commit por PR na `main`, com a mensagem do título do PR em Conventional Commits.
- Fim de fase: tag `fase-0`, `fase-1` etc. na `main` depois da aprovação do PO.

### 6.6 Pull requests (`.github/pull_request_template.md`)

- Título em Conventional Commits. PR pequeno (meta: menos de ~400 linhas alteradas, sem contar lockfile e assets).
- Seções: **O que e por quê** (link para a história do `backlog.md`), **Como testar** (comandos), **Checklist**: testes novos ou alterados; `pnpm check` verde; regras de permissão testadas no servidor (quando houver); contrato em `packages/shared` atualizado; README/docs atualizados; capturas de tela de iOS e Android quando houver UI.

## 7. Tarefas da Fase 0 (ordem e estimativa)

Estimativa em horas de trabalho de um dev. A ordem coloca primeiro o que pode derrubar o plano (portão do ADR 0001).

| # | Tarefa | Especialização | Estimativa | Depende de |
|---|---|---|---|---|
| T01 | Raiz do monorepo: `package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.npmrc`, `.editorconfig`, `.gitignore`, `.gitattributes`, Prettier | full stack | 3 h | pnpm instalado (DevOps) |
| T02 | `packages/config`: tsconfigs base e ESLint flat configs | full stack | 3 h | T01 |
| T03 | **Portão ADR 0001, parte 1**: scaffold mínimo do app (Expo 58 + Router) e `expo export` / `expo prebuild` com pnpm isolado; teste de `sharp` e `@node-rs/argon2` numa pasta temporária fora do repo | front | 4 h | T02 |
| T04 | `packages/shared`: erros e schemas de health, build dual, testes | back | 3 h | T02 |
| T05 | `packages/db`: `drizzle.config.ts`, `createDb`, testes unitário e de integração | back | 3 h | T02 |
| T06 | `apps/api`: bootstrap ESM, config Zod, logger, `DomainError` + filtro, módulos database/redis, health, testes unitários e e2e com Vitest + SWC | back | 8 h | T04, T05, compose (DevOps) |
| T07 | `apps/worker`: application context, config, logger, shutdown, teste | back | 3 h | T06 |
| T08 | `apps/mobile`: `app.config.ts`, `eas.json`, fontes, splash, tela inicial, Jest + RNTL funcionando, `dev-routes` | front | 5 h | T03 |
| T09 | `packages/ui`: `theme.ts`, `Logo`, `Icon`, setup de testes | front | 4 h | T08, `ux.md` |
| T10 | Componentes base: Avatar, Button, Input, TopTabs, BottomTabBar, Toast, EmptyState, CaughtUp, StatsRow (com testes de render, variantes, acessibilidade) | front | 18 h | T09, `ux.md` |
| T11 | Tela `/dev/catalog` com todas as variantes e estados, bloqueada fora de dev | front | 4 h | T10 |
| T12 | Ícone e splash gerados do `<Logo>` (`generate-icons.mjs`) | front | 2 h | T09 |
| T13 | Sentry mínimo no app e na API/worker (só com DSN) | full stack | 3 h | T06, T08, **decisão D4** |
| T14 | lefthook + commitlint, template de PR, README da raiz | full stack | 3 h | T01 |
| T15 | Integração com o compose e o CI do DevOps até o CI ficar verde | full stack | 2 h | `infra.md` |
| T16 | Dev builds EAS Android e iOS, instalação em aparelho, verificação do catálogo | front | 4 h | T11, T12, contas Expo/Apple do PO |
| T17 | Execução final do critério de pronto (§8) e relatório ao PO | full stack | 2 h | todas |
| | **Total** | | **74 h** | |

- Com reserva de 20% para imprevistos de versão e Windows: **~89 h, por volta de 11 a 12 dias úteis de um dev.** Sem Sentry (D4 = Fase 6): 71 h.
- O caminho crítico é T01 → T02 → T03 → T08 → T09 → T10 → T11 → T16. T04 a T07 (back) andam em paralelo com T08 a T12 (front), se houver duas pessoas.
- T10 e T11 dependem do `ux.md`. Os tokens do briefing permitem começar o `theme.ts` antes.

## 8. Critério de pronto da Fase 0 (verificável)

Todos os comandos rodam no PowerShell da máquina do PO, na raiz `C:\dev\sussurro`, com o compose no ar (`infra.md`) quando indicado.

### 8.1 Portão do ADR 0001 (smoke test: Node 26 + pnpm isolado + Expo no Windows)

| # | Comando | Resultado esperado |
|---|---|---|
| S1 | `node -v` e `pnpm -v` | `v26.13.0` e `12.13.0` |
| S2 | `git config --get core.longpaths` e `reg query HKLM\SYSTEM\CurrentControlSet\Control\FileSystem /v LongPathsEnabled` | `true` e `0x1` |
| S3 | `pnpm install --frozen-lockfile` | sai com código 0, sem erro de peer dependency não resolvido |
| S4 | `pnpm --filter @sussurro/mobile exec expo-doctor` | nenhum problema crítico |
| S5 | `pnpm --filter @sussurro/mobile exec expo export --platform android --platform ios --output-dir .smoke-export` | bundles gerados para as duas plataformas; prova que o Metro resolve `@sussurro/ui` e `@sussurro/shared` com `node_modules` isolado |
| S6 | `pnpm --filter @sussurro/mobile exec expo prebuild --platform android --clean --no-install` | gera `apps/mobile/android` sem erro de autolinking (a pasta é apagada em seguida e não é versionada) |
| S7 | Numa pasta temporária fora do repo: `pnpm init`, `pnpm add sharp @node-rs/argon2`, `node --input-type=module -e "await import('sharp'); await import('@node-rs/argon2')"` | instala binários pré-compilados e importa sem node-gyp |
| S8 | `pnpm build` | `apps/api/dist` e `apps/worker/dist` gerados |

**Se S3, S5, S6 ou S7 falharem sem correção simples**: aplicar o plano B (§9) e registrar o resultado no ADR 0001.

### 8.2 Qualidade

| # | Comando | Resultado esperado |
|---|---|---|
| Q1 | `pnpm format:check` | nenhum arquivo fora do padrão |
| Q2 | `pnpm lint` | 0 erros, 0 avisos |
| Q3 | `pnpm typecheck` | 0 erros em todos os pacotes |
| Q4 | `pnpm test` | todos os testes unitários passam (shared, db, api, worker, ui, mobile) |
| Q5 | `pnpm test:e2e` (compose no ar) | `health.e2e-spec.ts` e `client.int.test.ts` passam |
| Q6 | Rodar `pnpm turbo run lint typecheck test` duas vezes seguidas | a segunda execução sai do cache (`FULL TURBO`) |
| Q7 | CI no primeiro PR (`infra.md`) | verde |

### 8.3 API e worker em execução

| # | Comando | Resultado esperado |
|---|---|---|
| A1 | `pnpm dev` e depois `curl.exe -i http://localhost:3000/health` | `200` e `{"status":"ok"}` |
| A2 | `curl.exe -i http://localhost:3000/health/ready` | `200` e `{"status":"ok","checks":{"postgres":{"status":"up",...},"redis":{"status":"up",...}}}` |
| A3 | Parar só o container do Redis e repetir A2 | `503`, `status` `"error"`, `redis.status` `"down"`, resposta em até ~1,5 s |
| A4 | `curl.exe -i http://localhost:3000/v1/nao-existe` | `404` e `{"code":"NOT_FOUND","message":...}` |
| A5 | Iniciar a API sem `DATABASE_URL` | o processo encerra no boot com mensagem apontando a variável |
| A6 | Worker: iniciar e enviar Ctrl+C | log de início e de desligamento gracioso, código de saída 0 |

### 8.4 App: o que "roda no iOS e Android (dev build)" significa na Fase 0

1. `eas build --profile development --platform android` e `--platform ios` terminam com sucesso no EAS.
2. O dev build está instalado em **um aparelho Android físico** (APK do link do EAS; não há Android Studio, então não há emulador, a menos que o PO o instale) e em **um iPhone físico** (distribuição interna, com o aparelho registrado por `eas device:create` e o Modo Desenvolvedor ligado).
3. Com `pnpm dev:mobile` rodando no PC e o celular na mesma rede Wi-Fi (ou com `--tunnel`), o app abre, mostra o ícone e o splash da marca, carrega Inter e Bricolage Grotesque e exibe a tela inicial com o lockup e a tagline.
4. `/dev/catalog` mostra todos os componentes base com variantes e estados, e um build sem rotas de dev (perfil `preview`) redireciona `/dev/catalog` para `/`.
5. Capturas de tela dos dois sistemas anexadas ao PR final da fase.

**O que depende do PO:**

| Necessidade | Para quê | Sem isso |
|---|---|---|
| Conta Expo (gratuita) | qualquer build EAS | nenhum dev build |
| Conta Apple Developer (US$ 99/ano) + iPhone com Modo Desenvolvedor | build iOS de distribuição interna | o item iOS do critério fica pendente; proponho que o PO aceite a Fase 0 com o Android verificado e o iOS como pendência registrada |
| Identificador do app (bundle id iOS / applicationId Android) | `app.config.ts` e registro na Apple. **Não dá para trocar depois de publicar** | usamos um provisório com sufixo `.dev` |
| Liberar o `node.exe` no Firewall do Windows (rede privada) | o celular acessar o Metro na porta 8081 | usar `--tunnel` (mais lento) |

### 8.5 Documentação

- `README.md` da raiz com pré-requisitos no Windows (Node, pnpm, WSL2, Docker, long paths), setup em até 5 comandos, tabela de scripts, como rodar o app no celular e links para `docs/equipe`.

## 9. Riscos da Fase 0 e plano B

| # | Risco | Sinal | Plano B |
|---|---|---|---|
| F0-1 | **pnpm isolado + Metro/autolinking**: lib nativa que não acha dependência com `node_modules` isolado | falha em S5/S6 ou erro de módulo não encontrado no dev build | `nodeLinker: hoisted` no `pnpm-workspace.yaml` (ADR 0001). Mudança de uma linha + reinstalação |
| F0-2 | **React 19.3 + RNTL 14 + `test-renderer`**: incompatibilidade de peers ou de render | erro no primeiro teste de componente | fixar o patch de `jest-expo` 58 e da RNTL que o template do Expo usa. Em último caso, testar com `test-renderer` direto até sair correção |
| F0-3 | **Node 26 recém-LTS**: CLI do Expo, Jest 30, Nest CLI ou binários nativos falham | S3 a S8 | Node 24 LTS: troca `.nvmrc`, `engines`, `eas.json` e Dockerfile (ADR 0001) |
| F0-4 | **Metadata de decorators no Vitest** (Vite 8 usa Oxc) | `app.module.spec.ts` falha com dependência `undefined` | conferir se o `unplugin-swc` está como transformador único. Plano B: Jest 30 + `@swc/jest` |
| F0-5 | **NestJS 12 ESM** com libs CJS (pg, ioredis, nestjs-pino) | erro de import no boot | interop padrão do Node resolve; plano B é projeto Nest CJS (ainda suportado) |
| F0-6 | **TypeScript 7** sendo instalado por engano (é o `latest` no npm) | `typescript-eslint` reclama do peer | versão fixada em `6.0.3` na raiz e via `overrides` |
| F0-7 | **Extensões `.ts` nos imports** do `shared` no Metro e no Node | S5 ou boot da API falham | trocar para pacote sem imports relativos (arquivos achatados reexportados) ou buildar o `shared` também para o Metro |
| F0-8 | Windows: caminho longo, CRLF, antivírus deixando `pnpm install` lento | S2, diffs com CRLF, install acima de 10 min | `.gitattributes` + `core.longpaths`; sugerir ao PO a exclusão do Defender para `C:\dev` e para o store do pnpm (opcional) |
| F0-9 | Contas Expo/Apple não prontas | T16 bloqueada | entregar a Fase 0 com o Android verificado e o iOS pendente, se o PO aceitar |
| F0-10 | `ux.md` atrasado ou com mudanças nos componentes | T09 a T11 paradas | começar pelos tokens do briefing e pelo `Logo` (especificados por completo) |
| F0-11 | `ioredis` 6.0 é um major recente | erro de tipos ou API | fixar `ioredis` 5.x |
| F0-12 | pnpm bloqueia scripts de instalação por padrão | `@swc/core` ou `sharp` sem binário | incluir o pacote na lista de builds permitidos do `pnpm-workspace.yaml` |

## 10. Pergunta em aberto: Sentry na Fase 0? (D4)

A especificação diz "Sentry no app e na API **desde o início**" (§5) e coloca "Sentry" na Fase 6 (§8).

**Recomendação: opção mínima na Fase 0 (+3 h), o resto na Fase 6.**

| | Fase 0 (mínimo) | Fase 6 (completo) |
|---|---|---|
| App | `@sentry/react-native` inicializado em `src/lib/sentry.ts` **só se `EXPO_PUBLIC_SENTRY_DSN` existir**; `sendDefaultPii: false`; sem tracing; config plugin sem upload de source maps | upload de source maps no EAS, `release`/`dist`, ambientes, breadcrumbs de navegação |
| API e worker | `@sentry/nestjs` em `instrument.ts` carregado com `node --import` antes do app (exigência do ESM), **só se `SENTRY_DSN` existir**; o filtro global envia só erros 500 | `beforeSend` removendo campos de relacionamento e tokens (ADR 0004), tracing com amostragem, alertas |
| Conta Sentry | **não é necessária** (sem DSN, o SDK não faz nada) | necessária |

Assim o requisito "desde o início" é atendido no código, sem exigir conta nem configurar nada que só faz sentido com usuários reais.

## 11. Outras perguntas para o PO (Fase 0)

1. **Componentes base** (§1.1): aceita que a Fase 0 entregue os 11 componentes sem dados de domínio e que os compostos nasçam nas fases que os usam?
2. **Identificador do app**: qual bundle id / applicationId (ex.: `com.<seu-dominio>.sussurro`) e qual conta Expo vai ser dona do projeto? É permanente depois da publicação.
3. **iOS sem conta Apple pronta**: aceita fechar a Fase 0 com o Android verificado e o iOS como pendência?
4. **Hooks de Git** (lefthook + commitlint): ok incluir? É ferramenta de desenvolvimento, sem efeito no produto.
5. **`theme.ts`**: a especificação cita `packages/ui/theme.ts`; o arquivo fica em `packages/ui/src/theme.ts`, importado como `@sussurro/ui/theme`. Só uma questão de caminho, sem mudar os tokens.

## 12. Divergências e complementos em relação à arquitetura

| Ponto | Arquitetura/ADR | Este plano | Motivo |
|---|---|---|---|
| pnpm | "via corepack" | instalado à parte, `packageManager` fixado | o Node 26 não traz o corepack (`HANDOFF.md` §6) |
| Health | `GET /health` + `GET /health/ready` | igual: `/health` é liveness (sem dependências) e `/health/ready` verifica Postgres e Redis | segue a arquitetura; o pedido de "health que verifica Postgres e Redis" é atendido pelo `/ready` |
| TypeScript | não especificado | 6.0.3 fixado, não 7.0 | compatibilidade com typescript-eslint e decorators |
| Linter do Nest 12 | – | ESLint, não oxlint | especificação fixa ESLint |
| Metro | sem configuração manual | `metro.config.js` existe, mas só com o padrão do Expo | o pedido incluía o arquivo; a resolução dos pacotes vem da condição `react-native` |
| Drizzle | 0.45.x | 0.45.x, com reavaliação da 1.0 no início da Fase 1 | a 1.0 está em RC e muda o formato de migrations |

### 12.1 Divergências registradas na implementação (2026-10-29)

O que a implementação da Fase 0 mudou em relação a este plano, e por quê:

| Ponto | Plano | Implementado | Motivo |
|---|---|---|---|
| ESLint do app e da ui | `eslint-config-expo` (flat) | `eslint-plugin-react-hooks` 7 + `eslint-plugin-expo` direto, sobre a base | o `eslint-config-expo` 58 traz `eslint-plugin-react` 7.37 e `eslint-plugin-import` 2.32, que não declaram suporte ao ESLint 10 (peer não resolvido no `pnpm install`) |
| EAS CLI | devDependency do `apps/mobile` (`infra.md` §1.1 #11) | script `pnpm --filter @sussurro/mobile eas …` = `pnpm dlx eas-cli@27.1.0` | o `expo-doctor` reprova `eas-cli` nas dependências do projeto; a versão continua fixada, sem instalação global |
| React | 19.3.1 | 19.3.0 | é a versão do `bundledNativeModules.json` do Expo 58.0.21 |
| `@sentry/react-native` | 8.33 | ~8.28.0 | versão aprovada pelo Expo 58 |
| Sentry na API/worker | `sendDefaultPii: false` | `dataCollection` (sem usuário, cookies, cabeçalhos sensíveis nem corpos) + `beforeSend` que limpa a requisição | o `@sentry/nestjs` 11 substituiu `sendDefaultPii` por `dataCollection`. No app (RN 8.28) `sendDefaultPii: false` continua sendo a opção suportada. Sem config plugin do Sentry no app na Fase 0 (upload de source maps é Fase 6) |
| Fontes | config plugin do `expo-font` + `useFonts` como fallback | só `useFonts`, com o splash segurando a tela; import peso a peso | embutidas pelo plugin, a família no iOS é o nome PostScript e no Android o nome do arquivo; com `useFonts` o nome é o mesmo nas duas plataformas. O índice do `@expo-google-fonts/inter` colocava os 18 arquivos no bundle (~6 MB) |
| Ícones | `lucide-react-native` 1.64 | 1.63, import por ícone (`lucide-react-native/icons/<nome>`) | a 1.64 tem menos de 1 dia (`minimumReleaseAge`); o Metro não faz tree-shaking e o índice trazia ~1.900 ícones (bundle 7 MB → 4,5 MB). `align-left` e `trash-2` são apelidos (`text-align-start`, `trash`) |
| `expo-system-ui` | não previsto | incluído | o `expo prebuild` avisa que `userInterfaceStyle` não funciona no Android sem ele |
| Testes da API/worker | Vitest + `unplugin-swc` lendo o `.swcrc` | o `vitest.config.ts` lê o `.swcrc` e passa as opções ao `unplugin-swc`; `fsModuleCache: false` | o `unplugin-swc` monta um `jsc` próprio que anula o `.swcrc`, e o cache de transformação do Vitest 5 não percebe mudança no `.swcrc`. Sem isso o teste-sentinela F0-Q-08 não falhava |
| Desligamento | `enableShutdownHooks()` | handler próprio de SIGINT/SIGTERM (`shutdown.ts`) que chama `app.close()` e sai com 0 | o Nest reenvia o sinal ao processo depois de fechar, e o código de saída deixa de ser 0 (F0-API-07) |
| Worker | config, logger e desligamento | + providers de Postgres e Redis (preguiçosos) fechados no desligamento | para o desligamento "fechar os recursos" (CA3 da 0.5) e o boot exigir `DATABASE_URL`/`REDIS_URL` (CA2) |
| `/health/ready` | `{status, checks}` | cada check traz `status` e `latencyMs`; o motivo da falha vai só para o log | não expor detalhes internos numa rota sem autenticação |
| Tela inicial | `ux.md` §6.15: redireciona para o catálogo | lockup + tagline e botão para o catálogo em dev | segue o CA2 da história 0.7 e o §8.4 deste plano |
| `packages/ui` | só os 11 componentes | + `Text` (família por peso, `ux.md` §6.14) e `UiPreferencesProvider` (escala de fonte e "Reduzir movimento" simulados pelo catálogo) | todos os componentes dependem deles |
| Catálogo | `ux.md` §6.15 completo | Fundamentos (cores com contraste calculado, pastéis, tipografia, espaçamento, raios), Marca, Ícones e os 11 componentes com variantes e estados; controles de escala, movimento e fundo | "Sobrepor protótipo", "Telas compostas" e demonstração de radar/coração dependem de componentes das Fases 2 a 5 |
| `CaughtUp` | `ux.md`: "múltiplo de 48 h ou mais → dias" | múltiplos de 24 h a partir de 48 h → dias | a regra literal contradiz o CA7 da 0.8 (72 h → "últimos 3 dias") |
| App ↔ `shared` | — | `src/lib/error-messages.ts` (mensagem pt-BR por `ErrorCode`, `ux.md` §5.4), usado no catálogo | prova em runtime que o Metro resolve `@sussurro/shared` com imports `.ts` (risco F0-7 não se materializou) |
| `packages/ui` | só fonte TS | + `"type": "module"` e `jest.config.cjs`; export `./logo-geometry` | o `generate-icons.mjs` importa a geometria do logo direto do `.ts` (Node 26) |
| Turbo | tarefa `transit` | sem script `transit` nos pacotes | o Turborepo trata a tarefa como nó de trânsito sem precisar de script |
| lefthook | prettier + eslint só nos arquivos staged | prettier nos staged + `pnpm lint` (turbo com cache) | o ESLint usa a config de cada pacote |
| Prettier | tudo | ignora `docs/` e `CLAUDE.md` | documentos escritos à mão (tabelas e quebras intencionais) |
| pnpm | `allowBuilds` com a lista do plano | permitidos: `@swc/core`, `esbuild`, `sharp`, `unrs-resolver`; negados de propósito: `@parcel/watcher`, `@sentry/cli`, `dtrace-provider`, `lefthook`, `protobufjs` | o pnpm 12 falha o install com scripts não decididos; os negados têm binário pré-compilado ou não são necessários na Fase 0 |
| Jest (app e ui) | preset `jest-expo` | + `transformIgnorePatterns` que entende `node_modules/.pnpm` e `moduleNameMapper` do Lucide para o build CommonJS; `@react-native/jest-preset` como devDependency | layout do pnpm isolado; o `jest-expo` 58 exige o preset do RN como peer |
| Dependabot | citado no `infra.md` | `.github/dependabot.yml` (npm, GitHub Actions, docker-compose) | o CI fixa actions por SHA e depende dele para atualizar |
