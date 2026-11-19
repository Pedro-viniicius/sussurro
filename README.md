# Sussurro

Rede social **sem algoritmo**: o feed mostra só quem você segue ou com quem se conectou, em ordem cronológica, e termina em "Você está em dia". App Expo/React Native e API + worker NestJS, num monorepo pnpm + Turborepo.

Escopo, decisões e plano de cada fase: [`docs/equipe/PROJETO.md`](docs/equipe/PROJETO.md).

## Estrutura

| Pasta             | O que é                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile`     | App Expo SDK 58 + Expo Router (`src/app`), dev build                                                                                                                                                                                                                                                                                                                                                                                                                |
| `apps/api`        | API NestJS 12 (ESM): health; auth (JWT + refresh rotativo), perfil e conta em `/v1`; posts, feed, curtidas, comentários e avatar (Fase 2); busca, seguir, listas próprias, bloquear e denunciar (Fase 3); tokens de proximidade, pedidos de conexão e desfazer conexão (Fase 4); rascunho e publicação de reels (Fase 5); notificações, ponto azul e push tokens, com o push enfileirado na fila `push` (Fase 6)                                                    |
| `apps/worker`     | Worker NestJS: fila `media-jobs` (sharp, sem metadados; vídeo dos reels pelo `VideoProcessor`, passthrough ou MediaConvert), fila `video-events` (fim dos jobs do MediaConvert) fila `push` (Fase 6: envio ao Expo em lotes, recibos e `DeviceNotRegistered`) e jobs de manutenção e limpeza (hard delete, rascunhos, posts apagados, pedidos de conexão vencidos e antigos, notificações com mais de 90 dias e push tokens sem uso)                                |
| `packages/shared` | Contratos Zod (erros, health, auth, perfil, posts, reels, feed, comentários, avatar, busca, seguir, listas, bloqueio, denúncia, proximidade, pedidos de conexão, notificações, push tokens e a fila `push`) e regras de @, senha, texto, limites e duração do reel, QR e conteúdo do NFC (`sussurro://c/{token}`, ADR 0013); textos das notificações e do push e o agrupamento "Hoje"/"Esta semana"; a limpeza dos eventos do Sentry; fixtures de contagem de texto |
| `packages/db`     | Schema Drizzle, migrations, seed (personas, relações, posts, reels, bloqueio e denúncia de exemplo, personas da simulação de pedido, notificações de exemplo, modo volumoso) e utilitários de teste (Postgres ou PGlite)                                                                                                                                                                                                                                            |
| `packages/ui`     | `theme.ts`, `<Logo>`, componentes base e os de posts, comentários, Criar e perfil (catálogo em `/dev/catalog`)                                                                                                                                                                                                                                                                                                                                                      |
| `packages/config` | tsconfig e ESLint base                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `infra/local`     | Configuração dos emuladores S3/SQS e script do spike                                                                                                                                                                                                                                                                                                                                                                                                                |
| `infra/terraform` | Fase 7: Terraform da produção na AWS, só código (bootstrap, `envs/prod` e módulos; nunca `apply` sem o PO)                                                                                                                                                                                                                                                                                                                                                          |
| `docs/deploy`     | Fase 7: runbook de deploy e rollback, mapa das variáveis de produção e checklist das lojas                                                                                                                                                                                                                                                                                                                                                                          |

## Pré-requisitos (Windows 11)

Passo a passo completo em [`docs/equipe/infra.md` §1.1](docs/equipe/infra.md).

1. **Node 26.13.0** (`node -v`).
2. **pnpm 12.13.0, sem corepack** (o Node 26 não traz o corepack): `npm i -g pnpm@12.13.0` (`pnpm -v`).
3. **Git**: `git config --global core.longpaths true` e `git config --global core.autocrlf false` (o `.gitattributes` mantém LF).
4. **Caminhos longos** (PowerShell como administrador, depois reiniciar):
   `New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force`.
   Sem isso, o pnpm e o Node funcionam, mas o PowerShell e o Explorer não enxergam os arquivos do `node_modules` com mais de 260 caracteres. Para apagar o `node_modules`, use `pnpm clean`.
5. **WSL2 + Docker Desktop** (Postgres, Valkey e emuladores S3/SQS): `wsl --install --no-distribution` como administrador, reiniciar, criar `%UserProfile%\.wslconfig` com `[wsl2]` e `memory=3GB` e abrir o Docker Desktop uma vez.
6. **Firewall** (o celular precisa alcançar o PC), PowerShell como administrador:
   `New-NetFirewallRule -DisplayName "Sussurro dev" -Direction Inbound -Protocol TCP -LocalPort 3000,8081,8333 -Profile Private -Action Allow`, e marcar o Wi-Fi de casa como rede **Privada**.

## Setup

PowerShell, na raiz do repositório:

```powershell
pnpm install --frozen-lockfile   # 1. dependências e hooks de Git (lefthook)
Copy-Item .env.example .env      # 2. variáveis da API, do worker e do compose (e preencha JWT_ACCESS_SECRET)
pnpm check                       # 3. format, lint, typecheck e testes unitários (não precisa de Docker)
docker compose up -d --wait      # 4. Postgres, Valkey, ElasticMQ e SeaweedFS
pnpm db:migrate; pnpm db:seed    # 5. tabelas (drizzle-kit) e personas do protótipo
pnpm dev                         # 6. API (porta 3000), worker e watch dos pacotes
```

O `JWT_ACCESS_SECRET` é obrigatório: sem ele a API não sobe. Ele nunca vai para o Git. Para gerar um valor, rode `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` e cole o resultado no `.env`.

Para conferir: `curl.exe -i http://localhost:3000/health` responde 200; `curl.exe -i http://localhost:3000/health/ready` responde 200 com o compose no ar e 503 se o Postgres ou o Valkey cair. `pnpm test:e2e` roda os testes de integração. Para encerrar, Ctrl+C no terminal.

## Banco: migrations e seed (Fase 1)

- **Mudou o schema** (`packages/db/src/schema/`): `pnpm db:generate` cria a migration em `packages/db/migrations/`, que é versionada. Trigger e SQL que o drizzle-kit não gera entram por `pnpm --filter @sussurro/db exec drizzle-kit generate --custom --name <nome>` (ex.: `0001_users_account_type_immutable.sql`).
- **Aplicar**: `pnpm db:migrate` (drizzle-kit, no banco do `DATABASE_URL`). O CI faz o mesmo antes do `test:e2e`.
- **Seed** (A-08): `pnpm db:seed` cria as personas do protótipo, já com o e-mail confirmado: @helena, @caio.r e @marinac (pessoais) e @cozinhadabia e @trilhasdosul (criadores). A senha é `sussurro-dev-2026`, ou o valor de `SEED_PASSWORD`. Rodar de novo não duplica nada. O seed recusa `NODE_ENV=production`.
  - (Fase 2) Também cria as relações e os posts para ver o feed antes de existirem as telas de seguir (Fase 3) e de conectar (Fase 4): conexões helena–caio.r e helena–marinac (caio.r e marinac **não** são conexão, então um não vê os posts do outro), helena segue os dois criadores, caio.r segue @cozinhadabia e marinac segue @trilhasdosul. São 13 posts de foto e de texto entre 18 min e 100 h atrás (dentro e fora da janela de 72 h), com curtidas, comentários e respostas. Entre como `helena@example.com` para ver o feed mais cheio.
  - (Fase 3) Mais uma pessoa e três criadores para a busca, com prefixos parecidos com os @ pessoais: @estudante (pessoal, `lia@example.com`), @estudioaurora, @estudiovinil e @helenaviaja. A busca por `estu` acha os dois estúdios e nunca @estudante; `hele` acha @helenaviaja e nunca @helena. Também: @estudante segue @estudioaurora, @caio.r segue @estudiovinil, @trilhasdosul **bloqueou** @estudante (para ela, o criador some da busca e o perfil dá 404) e @helena **denunciou** a conta @estudiovinil. Numa base da Fase 2, rodar o seed de novo cria só as personas novas e os posts delas.
  - (Fase 4) Duas pessoas sem nenhuma conexão, cada uma com um post de texto: @lucasf (`lucas@example.com`) e @tomas (`tomas@example.com`). São as personas da simulação de pedido recebido em desenvolvimento (`POST /v1/dev/simulate-request`, @lucasf por padrão). Para testar o Conectar com dois aparelhos, use @caio.r e @marinac (não são conexão); para "já conectados" e "desfazer conexão", @helena com qualquer um dos dois.
  - (Fase 5) Cinco reels prontos (só as linhas, 720×1280, 15 a 90 s): @marinac (pessoal: só @helena vê, nunca @caio.r), @trilhasdosul (dois, um fora da janela de 72 h, com 90 s), @cozinhadabia e @helena. Rodar de novo não duplica; numa base das Fases 2 a 4, o seed cria só os reels.
  - (Fase 6) Notificações de exemplo, derivadas do que o seed já tem entre as personas: as curtidas, os comentários e as respostas (helena, caio.r, marinac e cozinhadabia), "Vocês estão conectados" para os dois lados das conexões e uma linha de seguidores por criador, anônima (cozinhadabia e trilhasdosul com "2 novas pessoas começaram a seguir você."). Rodar de novo, ou numa base das Fases 2 a 5, cria só o que falta (18 na primeira vez, 0 depois).
  - As fotos e os reels do seed apontam para objetos em `media/`. Com o compose no ar, `pnpm build` e depois `pnpm --filter @sussurro/worker seed:media` gravam no SeaweedFS imagens de exemplo (degradês gerados pelo sharp) para toda foto pronta que ainda não tem objeto e, para os reels, o poster 9:16 e um MP4 de exemplo montado em código, que **não toca** (para assistir, publique um vídeo pelo app).
  - `pnpm db:seed --volume` (ou `SEED_VOLUME=1`) cria também o seed volumoso do FEED-16: `leitor.volume@example.com` com 150 conexões, 500 criadores seguidos e 100 mil posts nos últimos 30 dias. Para medir: API no ar e `pnpm --filter @sussurro/api perf:feed [URL] [rodadas]`.
- **Sem Docker**: `pnpm db:pglite` sobe um Postgres 18 de desenvolvimento (PGlite pelo `@electric-sql/pglite-socket`) em `127.0.0.1:5433`, com os dados em memória. Com `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5433/postgres`, `pnpm db:migrate`, `pnpm db:seed` e a API funcionam. Sem Valkey, o rate limit libera e registra no log (fail-open, R11), o número de seguidores é contado no banco a cada leitura (sem o cache de 60 s, com um aviso no log) e o `/health/ready` responde 503. (Fase 4) A proximidade fica **fechada** sem Valkey (503 `PROXIMITY_UNAVAILABLE` em tokens, resolve, pedido e aceite; login e feed seguem). Para usar o Conectar sem Docker, suba a API com `PROXIMITY_STORE=memory`: os tokens ficam na memória da API (uma instância, somem ao reiniciar; recusado em produção). É só para desenvolvimento: o ambiente canônico continua sendo o compose.

## Testes de integração sem Docker (modo PGlite)

O padrão do `pnpm test:e2e` é o Postgres e o Valkey do compose (no CI, os services). Sem Docker, a escolha é explícita, pela variável `TEST_DB`:

```powershell
$env:TEST_DB = 'pglite'; pnpm test:e2e      # PowerShell
TEST_DB=pglite pnpm test:e2e                # Git Bash
```

- Cada arquivo de teste sobe um PGlite (Postgres 18 em WebAssembly) em memória e aplica **as mesmas migrations** do drizzle-kit. Os arquivos de teste são os mesmos nos dois modos. Os utilitários ficam em `@sussurro/db/testing`, e o código de produção não depende do PGlite: ele é só `devDependency` do `packages/db`.
- O rate limit usa um fake em memória (`apps/api/src/testing/in-memory-rate-limit.store.ts`) que implementa a mesma porta `RateLimitStore` do Valkey.
- (Fase 2) S3 e SQS: nos dois modos, a suíte principal usa fakes em memória das mesmas portas (`ObjectStorage`, `MediaJobsQueue` na API; `ObjectStorage`, `MessageQueue` no worker). O fake do S3 assina as URLs com o presigner do próprio AWS SDK (sem rede) e reproduz as recusas do S3 (URL vencida, tipo ou tamanho diferente do assinado); o da fila tem visibility timeout, `ApproximateReceiveCount` e redrive para a DLQ. As URLs de leitura saem no formato do CloudFront, assinadas com uma chave RSA gerada no próprio teste e conferidas com a chave pública. As fixtures de imagem (EXIF, GPS, XMP, IPTC, orientação de 90°, HTML e SVG disfarçados, PNG de 30000×30000 px) são geradas pelo sharp e pelo zlib na hora; nada é baixado.
- Testes pulados nesse modo, com o motivo no arquivo. Todos rodam no CI, que usa o modo Postgres (ver "CI"):
  - `client.int.test.ts`: pool do `node-postgres` contra um servidor;
  - `real-services.e2e-spec.ts`: refresh concorrente com `FOR UPDATE` entre várias conexões e o script Lua do rate limit;
  - F0-API-02 (`/health/ready` com Valkey real);
  - (Fase 2) `media-real-services.e2e-spec.ts` (API): o SeaweedFS recusar PUT maior que o `Content-Length` assinado (MID-03) e PUT com a URL vencida (MID-07), o `publish` com HEAD e SQS reais (MID-08) e o GET pré-assinado adulterado ou sem assinatura recusado (PERM-16);
  - (Fase 2) `real-services.int-spec.ts` (worker): redrive para a DLQ no ElasticMQ depois de 3 entregas (MID-10) e o adaptador S3 contra o SeaweedFS;
  - (Fase 3) `real-services.e2e-spec.ts` (API): o cache de seguidores no Valkey (`MGET` e `SET PX`, CNT-02) e seguir e bloquear o mesmo par em paralelo, em conexões diferentes do pool (a trava do par, X.2);
  - (Fase 4) `real-services.e2e-spec.ts` (API): o adaptador Redis dos tokens de proximidade no Valkey (`MULTI`, `MGET`, `PEXPIRE`, só o hash nas chaves, revogação, contador e bloqueio; 2 testes).
- (Fase 3) O cache de seguidores usa, nos dois modos, um fake em memória da porta `CounterCache` sobre o relógio de teste: o teste avança o relógio 60 s em vez de esperar.
- (Fase 4) Os tokens de proximidade usam, nos dois modos, o fake em memória da porta `ProximityStore` (`apps/api/src/testing/test-proximity.store.ts`), com as mesmas chaves e validades sobre o relógio de teste (30 e 120 s sem `sleep`) e um interruptor que simula o Valkey fora (PROX-21). No modo `postgres`, a corrida A→B ∥ B→A (PROX-13) roda com transações de verdade em conexões diferentes do pool; no PGlite, as transações são serializadas, então a trava do par só é posta à prova no Postgres.
- (Fase 5) Reels: os vídeos de teste são montados em código (`apps/worker/src/media/mp4-sample.ts`: `ftyp`, `moov` e `mdat`, com duração, tamanho, rotação, `moov` no fim, MP4 fragmentado e localização `©xyz`), sem ffmpeg nem download; eles têm a estrutura que o worker lê, mas não tocam. O MediaConvert é um dublê do cliente da AWS (nenhuma chamada sai da máquina) e os eventos do EventBridge são montados no teste. O adaptador S3 do worker (HEAD, leitura por intervalo e cópia) contra o SeaweedFS fica no `real-services.int-spec.ts`, pulado no PGlite. A remoção da localização pelo MediaConvert de verdade só depois do `apply` (A-21): roteiro em [`testes.md` §8.2](docs/equipe/testes.md).
- (Fase 6) Push: a fila `push` da API é um fake em memória nos dois modos (`apps/api/src/testing/in-memory-push-queue.ts`), e o Expo Push é o fake da porta `PushSender` (`apps/worker/src/testing/fake-push-sender.ts`), com "fora do ar", `DeviceNotRegistered` no envio e recibos programados: nenhum teste chama o Expo. O Sentry é testado com um transporte falso (os envelopes ficam na memória do teste). O `RETURNING old.*` do upsert de seguidores é do Postgres 18, o mesmo no PGlite.
- No modo `postgres`, cada arquivo cria um banco `sussurro_test_*`, aplica as migrations e o apaga no fim, e usa um índice do Valkey por worker. Os testes com S3/SQS reais usam o compose (`docker compose up -d --wait elasticmq seaweedfs s3-init`) e criam filas próprias.

## Privacidade e testes de permissão

Desde a Fase 3. As regras de visibilidade ficam todas no servidor, num ponto só (`AccessPolicyService`, `apps/api/src/modules/policies`), e cada uma tem teste com o ID do caso de `docs/equipe/testes.md`.

- **Quem vê o quê** (`arquitetura.md` §7): criador é visível a qualquer conta; perfil e posts de conta pessoal, só às conexões. Bloqueio (X.2) nos dois sentidos: os dois deixam de se ver (perfil, posts, comentários e busca) e quem não pode ver recebe o mesmo 404 de algo inexistente.
- **Listas de relacionamento só para o dono** (ADR 0004): `GET /me/connections`, `/me/following` e `/me/blocks`. Não existe rota com o id ou o @ de outra conta que devolva lista; seguidores de criador não têm lista nem para o próprio criador. Uma regra de lint impede importar as funções de listagem fora do `MeListsController` (`apps/api/eslint.config.mjs`).
- **Testes que vigiam isso** (`apps/api/test/e2e`):
  - `privacy-canary.e2e-spec.ts`: o **canário** (PERM-10 e 10b). Y é conectado a `canary_conn_*`, segue `canary_creator_*`, bloqueou `canary_block_*`, foi bloqueado por `canary_blkby_*` e (Fase 4) tem um pedido de conexão pendente de `canary_req_in_*` e outro para `canary_req_out_*`. O teste chama **todas** as rotas registradas como conexão de Y, pessoa desconhecida, criador e anônimo, e nenhum corpo ou header pode conter os canários (fora da allowlist do arquivo). **Rota nova sem fixture faz o teste falhar**: quem cria a rota acrescenta a entrada no mapa do arquivo. O mesmo arquivo tem o inventário PERM-09;
  - `routes.e2e-spec.ts`: 401 sem token (PERM-18), schema de resposta obrigatório (PERM-12) e o guard de tipo de conta por módulo (PERM-05);
  - `blocks`, `search`, `follows`, `own-lists`, `reports` e `seed-privacy` (relações reais do seed): os casos de cada história;
  - (Fase 4) `proximity`, `connections` e `dev-routes`: o protocolo de conexão presencial (PROX-*).
- **Pedidos de conexão** (Fase 4): cada pedido só é visível às duas pessoas dele (terceiro → o 404 de inexistente) e a caixa de entrada só lista os pedidos para quem chama. Quem pediu nunca sabe se foi recusado: recusa, expiração e cancelamento aparecem igual ("não confirmado"), e um novo pedido durante a hora seguinte à recusa recebe a mesma mensagem de token inválido.
- **Notificações** (Fase 6): só as de quem chama, sem rota com id ou @ de outra conta. A de seguidores é anônima no banco (`CHECK` com `actor_id` nulo e `payload` vazio), no schema da resposta (só o número) e no push ("3 novas pessoas…"). O canário ganhou os seguidores `canary_follower_*` de X3 (criador): nem o próprio criador vê quem o seguiu (NOT-02). Bloqueio, conta ou post apagados e conexão desfeita escondem as notificações (NOT-09, X.2). Push tokens só são mexidos pelo dono (6.4 CA3), e o token vai no corpo, nunca na URL.
- **Schemas públicos**: `packages/shared/src/public-schemas.test.ts` é o snapshot (PERM-11). Um campo novo numa resposta faz o teste falhar até o snapshot ser revisto no PR; o interceptor da API descarta qualquer campo fora do schema.

## Scripts da raiz

| Script                                                    | O que faz                                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm dev`                                                | API + worker em modo watch + `tsc -w` de `shared` e `db` (lê o `.env` da raiz)                                    |
| `pnpm dev:mobile`                                         | `expo start --dev-client` (Metro para o dev build no celular)                                                     |
| `pnpm build`                                              | Builda `shared`, `db`, API e worker em `dist/`. O app sai pelo EAS                                                |
| `pnpm lint`                                               | ESLint em todos os pacotes, com 0 avisos                                                                          |
| `pnpm typecheck`                                          | `tsc --noEmit` em todos os pacotes                                                                                |
| `pnpm test`                                               | Testes unitários (Vitest em api, worker, shared e db; Jest + RNTL em mobile e ui), sem Docker                     |
| `pnpm test:e2e`                                           | Integração e e2e contra Postgres e Valkey (`docker compose up -d --wait`) ou, com `TEST_DB=pglite`, sem Docker    |
| `pnpm test:cov`                                           | Testes unitários com relatório de cobertura em `coverage/` de cada pacote                                         |
| `pnpm format` / `pnpm format:check`                       | Prettier (grava / só confere)                                                                                     |
| `pnpm check`                                              | `format:check` + lint + typecheck + test (o que o CI roda no job `quality` e no `test`)                           |
| `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:studio` | drizzle-kit: gerar migration, aplicar, abrir o Studio                                                             |
| `pnpm db:seed`                                            | Personas do protótipo, relações e posts no banco do `DATABASE_URL` (nunca em produção); `--volume` para o FEED-16 |
| `pnpm --filter @sussurro/worker seed:media`               | Imagens de exemplo no S3 do `.env` para as fotos e os reels do seed (depois do `pnpm build`, com o compose no ar) |
| `pnpm --filter @sussurro/api perf:feed [URL] [rodadas]`   | Mede p50/p95 do `GET /v1/feed` com o seed volumoso (FEED-16), contra uma API no ar                                |
| `pnpm db:pglite`                                          | Postgres de desenvolvimento sem Docker (PGlite) em `127.0.0.1:5433`                                               |
| `pnpm spike:aws`                                          | Spike S3/SQS contra os emuladores (F0-DC-07); precisa do compose no ar                                            |
| `pnpm clean`                                              | Apaga `dist`, `coverage`, caches e `node_modules`                                                                 |

Um pacote só: `pnpm --filter @sussurro/api test`. Um caso: `pnpm --filter @sussurro/api exec vitest run -t "F0-API-06"`.

## App no celular (dev build)

Não há emulador nem Mac. O app roda num **dev build do EAS** instalado no aparelho, e o JavaScript vem do Metro no PC.

1. Criar uma conta Expo (grátis) e entrar: `pnpm --filter @sussurro/mobile eas login` (usa `eas-cli` 27.1.0 via `pnpm dlx`, sem instalação global).
2. Gerar o dev build:
   - Android: `pnpm --filter @sussurro/mobile eas build --profile development --platform android` e instalar o APK pelo link do EAS.
   - iPhone: exige conta Apple Developer paga. Registrar o aparelho com `pnpm --filter @sussurro/mobile eas device:create`, gerar com `--platform ios` e ligar o **Modo de Desenvolvedor** no iPhone.
3. No PC, `pnpm dev:mobile`, com o celular **na mesma Wi-Fi** do PC (rede Privada, firewall liberado nas portas 3000, 8081 e 8333). Se a rede bloquear, use `pnpm dev:mobile --tunnel` (só o Metro passa pelo túnel).
4. `Copy-Item apps/mobile/.env.example apps/mobile/.env` e ajustar o `EXPO_PUBLIC_API_URL` para o IP do PC na LAN (ex.: `http://192.168.0.10:3000`).
5. Sem sessão o app abre em **Entrar**. Para testar, use uma persona do `pnpm db:seed` (ex.: `helena@example.com` ou `bia@example.com`, senha `sussurro-dev-2026`). A conta pessoal cai no Início, com 5 abas; a de criador cai no Perfil, com 3 abas. Em dev, **Catálogo de componentes (dev)**, no fim de Entrar, leva a `/dev/catalog`; fora de dev essa rota só existe com `EXPO_PUBLIC_DEV_TOOLS=1`.
6. **Links dos e-mails** (confirmação e redefinição de senha): em dev, a API escreve no log uma linha `E-mail (dev) para …` com o link `sussurro://verificar-email?token=…` ou `sussurro://redefinir-senha?token=…`. Para abrir no celular:
   - no iPhone, cole o link na barra do Safari, que oferece abrir o app;
   - no Android, `adb shell am start -a android.intent.action.VIEW -d "<link>"` (Android platform-tools).

   Em produção (Fase 7), o e-mail sai pelo SES com um link https.

7. **Dev build novo**: a Fase 1 adicionou `expo-secure-store` (refresh token no Keychain/Keystore) e `expo-network` (faixa "Sem internet"). Os dev builds da Fase 0 não têm esses módulos, então é preciso gerar o build de novo. A Fase 2b adicionou mais três módulos nativos (`expo-image`, `expo-image-picker` e `expo-image-manipulator`): de novo, um dev build novo. A Fase 4b adicionou o `expo-camera` e o módulo local `sussurro-proximity` (Bluetooth, `apps/mobile/modules/`): outro dev build novo. A Fase 5b adicionou o `expo-video` e o `expo-video-thumbnails` (reels): mais um dev build novo. A Fase 6b adicionou o `expo-notifications` (com o `expo-application`), as configurações de push e o plugin do Sentry (source maps): outro dev build novo, que só recebe push com as credenciais de push no EAS (ver "Fase 6b: verificado × pendente").

Variantes (`APP_VARIANT` no `eas.json`): `development` → `app.sussurro.dev`, `preview` → `app.sussurro.preview`, `production` → `app.sussurro`. Alvos mínimos do Expo SDK 58: iOS 16.4 e Android `minSdk` 24 (`targetSdk` 36).

## Variáveis novas da Fase 1

Todas estão no `.env.example`, com os padrões. A validação fica em `apps/api/src/config/env.schema.ts` e `apps/worker/src/config/env.schema.ts`: a API não sobe se faltar uma obrigatória.

| Variável                                                                                  | Onde   | O que é                                                                                              |
| ----------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET` (obrigatória, 32+ caracteres) / `JWT_ACCESS_KID` (`k1`)               | API    | Segredo HMAC do access token e o `kid` no cabeçalho do JWT                                           |
| `JWT_ACCESS_PREVIOUS_SECRET` / `JWT_ACCESS_PREVIOUS_KID`                                  | API    | Segredo anterior, aceito só na verificação durante uma rotação                                       |
| `ACCESS_TOKEN_TTL_S` (900), `REFRESH_TOKEN_TTL_S` (2592000), `REFRESH_REUSE_GRACE_S` (20) | API    | Validade do access e do refresh e janela em que reusar um refresh conta como retry (A-27)            |
| `EMAIL_VERIFICATION_TTL_S` (86400), `PASSWORD_RESET_TTL_S` (3600)                         | API    | Validade dos links de confirmação de e-mail e de redefinição de senha                                |
| `EMAIL_SENDER` (`log`), `EMAIL_FROM`, `EMAIL_LINK_BASE_URL` (`sussurro://`)               | API    | `log` escreve o e-mail no log (dev); `ses` usa o AWS SES (obrigatório em produção, com `AWS_REGION`) |
| `TRUST_PROXY_HOPS` (0)                                                                    | API    | Proxies confiáveis (ALB = 1); define o IP usado no rate limit                                        |
| `ACCOUNT_PURGE_AFTER_DAYS` (30, máximo 30), `MAINTENANCE_INTERVAL_MS` (3600000)           | worker | Prazo do hard delete das contas excluídas e intervalo do job                                         |
| `TEST_DB` (`postgres` ou `pglite`)                                                        | testes | Onde rodam a integração e o e2e (ver acima)                                                          |
| `SEED_PASSWORD`, `PGLITE_PORT` (5433), `PGLITE_DATA_DIR`                                  | dev    | Senha das personas do seed e o Postgres de desenvolvimento sem Docker                                |

## Variáveis novas da Fase 2

Também no `.env.example`, com os padrões e a mesma validação no boot.

| Variável                                                                                                   | Onde         | O que é                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `FEED_WINDOW_HOURS` (72)                                                                                   | API          | Janela do feed, inteiro de 1 a 720. Valor inválido ou vazio impede a API de subir (FEED-03b)                                                                       |
| `AWS_REGION`, `AWS_ENDPOINT_URL_S3`, `S3_FORCE_PATH_STYLE`, `S3_BUCKET_MEDIA`                              | API e worker | S3 (SeaweedFS em dev; endpoint vazio = AWS real)                                                                                                                   |
| `S3_PUBLIC_ENDPOINT_URL`                                                                                   | API          | Host das URLs pré-assinadas, que o celular usa (IP do PC na LAN em dev)                                                                                            |
| `AWS_ENDPOINT_URL_SQS`, `SQS_QUEUE_MEDIA_JOBS` (`media-jobs`)                                              | API e worker | Fila do processamento de imagens (ElasticMQ em dev)                                                                                                                |
| `PRESIGN_PUT_TTL_S` (600), `MEDIA_URL_TTL_S` (21600)                                                       | API          | Validade da URL de upload (10 min) e das URLs de leitura (6 h, A-19)                                                                                               |
| `MEDIA_URL_SIGNER` (`s3-presign`), `CLOUDFRONT_DOMAIN`, `CLOUDFRONT_KEY_PAIR_ID`, `CLOUDFRONT_PRIVATE_KEY` | API          | Leitura da mídia: GET pré-assinado no S3 (dev) ou URL assinada do CloudFront (obrigatório em produção, com as três variáveis; a chave em PEM numa linha, com `\n`) |
| `MEDIA_JOBS_CONCURRENCY` (2), `MEDIA_JOBS_WAIT_S` (20), `MEDIA_JOBS_MAX_ATTEMPTS` (3)                      | worker       | Consumidor `media-jobs`: mensagens em paralelo, long polling e tentativas (igual ao `maxReceiveCount` da DLQ)                                                      |
| `MEDIA_MAX_INPUT_PIXELS` (40000000)                                                                        | worker       | Teto de pixels de uma imagem (MID-06)                                                                                                                              |
| `DRAFT_TTL_HOURS` (24), `MEDIA_PROCESSING_TIMEOUT_MIN` (60)                                                | worker       | Limpeza de rascunhos e uploads de avatar abandonados (2.11) e da mídia presa em `processing`                                                                       |
| `SEED_VOLUME` (`1`)                                                                                        | dev          | O mesmo que `pnpm db:seed --volume`                                                                                                                                |

## Variáveis novas da Fase 3

Também no `.env.example`, com a mesma validação no boot.

| Variável           | Onde | O que é                                                                                                                                                                                              |
| ------------------ | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MODERATION_EMAIL` | API  | Fila de moderação mínima (X.1): cada denúncia nova manda um e-mail para este endereço. Obrigatória em produção; vazia em dev = `moderacao@example.com`, que com `EMAIL_SENDER=log` só aparece no log |

## Variáveis novas da Fase 4

Também no `.env.example`, com a mesma validação no boot (A-27: os tempos do protocolo vêm do env).

| Variável                                                                     | Onde | O que é                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROX_TOKEN_TTL_S` (30), `PROX_RECENT_TTL_S` (120), `PROX_SCREEN_TTL_S` (30) | API  | Token de proximidade válido (resolve e pedido), recente (só o aceite) e a marca de "tela Conectar aberta" renovada a cada token. O recente não pode ser menor que o válido. O app renova a cada 2/3 da validade (`renewInS` = 20 s) |
| `PROX_TOUCH_PAIRS_PER_HOUR` (10), `PROX_TOUCH_PAIRS_PER_DAY` (30)            | API  | (Adendo A2, decisão do PO) Teto de pares novos por conta, por hora e por dia; acima dele o encosto só não confirma (resposta igual a não mútuo). O diário não pode ser menor que o por hora                                         |
| `CONNECTION_REQUEST_TTL_S` (120), `CONNECTION_DECLINE_COOLDOWN_S` (3600)     | API  | Validade do pedido pendente e o intervalo depois de uma recusa (quem pediu não consegue pedir de novo à mesma pessoa)                                                                                                               |
| `PROXIMITY_STORE` (`redis`)                                                  | API  | Onde ficam os tokens: `redis` (Valkey; obrigatório em produção; sem ele, Conectar responde 503) ou `memory` (só desenvolvimento sem Docker; uma instância, some ao reiniciar)                                                       |

## Variáveis novas da Fase 5

Também no `.env.example`, com a mesma validação no boot. Os limites do reel (D10: 90 s e 200 MB; poster até 5 MB) são constantes do `packages/shared` (`MAX_REEL_DURATION_S`, `MAX_VIDEO_BYTES`, `MAX_POSTER_BYTES`), as mesmas no app e na API, e não variáveis.

| Variável                                          | Onde   | O que é                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VIDEO_PROCESSOR` (`passthrough`)                 | worker | Quem processa o vídeo dos reels (ADR 0006): `passthrough` (dev e testes: confere o vídeo, copia o original para `media/{id}/video.mp4` e usa o poster do app, sem metadados; **o vídeo copiado mantém os metadados do original**, inclusive a localização) ou `mediaconvert` (AWS MediaConvert). Outro valor impede o worker de subir (5.1 CA2); em produção, só `mediaconvert`. Em dev, publique só vídeos de teste sem localização (A-21) |
| `MEDIACONVERT_ROLE_ARN`, `MEDIACONVERT_QUEUE_ARN` | worker | Role de serviço do MediaConvert (lê `incoming/*`, grava `media/*`; obrigatória com `mediaconvert`) e a fila dele (opcional; vazio = `Default`). O cliente usa o endpoint regional padrão e as credenciais da task                                                                                                                                                                                                                           |
| `SQS_QUEUE_VIDEO_EVENTS` (`video-events`)         | worker | Fila dos eventos de fim de job do MediaConvert (EventBridge → SQS). O consumidor só sobe com `mediaconvert`, com a mesma concorrência, espera e tentativas da `media-jobs` (`MEDIA_JOBS_*`)                                                                                                                                                                                                                                                 |

O `MEDIA_PROCESSING_TIMEOUT_MIN` (60) também vale para o vídeo: um reel em `processing` há mais tempo (o evento do MediaConvert não chegou) vira `failed`.

## Variáveis novas da Fase 6

Também no `.env.example`, sem valores reais e com a mesma validação no boot. Prazos que são regra de negócio (lista de 30 dias, retenção de 90 dias, 10 push tokens por conta, recibos depois de 15 min) são constantes do código, não variáveis.

| Variável                                                                                         | Onde         | O que é                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SQS_QUEUE_PUSH` (`push`)                                                                        | API e worker | Fila do push (com a `push-dlq`, 3 entregas). A API manda só ids; o worker monta o texto curto                                                                                                                                                                                                    |
| `PUSH_SENDER` (`log`)                                                                            | worker       | `expo` (Expo Push Service; obrigatório em produção) ou `log` (dev e testes: escreve no log o texto e o token mascarado, nada sai da máquina). Outro valor impede o worker de subir                                                                                                               |
| `EXPO_ACCESS_TOKEN`                                                                              | worker       | Access token do Expo, se a "segurança reforçada" de push estiver ligada no projeto. **Segredo** (Secrets Manager em produção); vazio = sem token                                                                                                                                                 |
| `PUSH_JOBS_CONCURRENCY` (10), `PUSH_JOBS_MAX_ATTEMPTS` (3), `PUSH_RECEIPTS_INTERVAL_MS` (900000) | worker       | Mensagens da `push` por rodada (até 10, o máximo do SQS), tentativas (= `maxReceiveCount` da DLQ) e o intervalo da consulta dos recibos do Expo                                                                                                                                                  |
| `SENTRY_DSN`, `SENTRY_ENVIRONMENT` (`local`), `SENTRY_RELEASE`, `SENTRY_TRACES_SAMPLE_RATE` (0)  | API e worker | Sentry completo (6.7): sem DSN nada é inicializado nem enviado (D4); release (o SHA no CI; vazio = o SDK descobre), ambiente e amostragem do tracing de 0 a 1. O DSN não é segredo, mas fica fora do repositório                                                                                 |
| `OTEL_ENABLED` (`false`)                                                                         | API e worker | Pontos de OpenTelemetry (6.8). Desligado, nada é chamado no `@opentelemetry/api` (sem exportador e sem custo); o `traceId` vai para o log de qualquer jeito. Ligado, os spans usam o tracer global (no-op sem SDK; com o Sentry, entram nele) e o `traceparent` vai nos atributos da fila `push` |
| `EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` (0)                                                      | app          | Amostragem do tracing do Sentry no app, de 0 a 1 (vazia ou inválida = 0), por perfil do EAS. O DSN do app continua em `EXPO_PUBLIC_SENTRY_DSN` (Fase 0)                                                                                                                                          |
| `EAS_PROJECT_ID`, `GOOGLE_SERVICES_JSON`                                                         | app (build)  | Troca o projeto do EAS (vazio = o fixo no `app.config.ts`, `d52fca2b-…`, criado com `eas init`) e o caminho do `google-services.json` do Firebase (FCM), como variável de arquivo do EAS. Só no build: não vão para o bundle                                                                     |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`                                              | app (build)  | Upload dos source maps no EAS Build (6.7 CA3). O token é **secret** do EAS e nunca entra na configuração; sem os três, o upload fica desligado e o build não falha                                                                                                                               |

## CI

O GitHub Actions (`.github/workflows/ci.yml`) roda em cada PR e em cada push na `main` os jobs `secrets` (gitleaks), `quality` (lint, typecheck, format e título do PR), `test` (unitários e e2e com Postgres e Valkey e, desde a Fase 2, o ElasticMQ e o SeaweedFS do compose), `build` e, desde a Fase 7, `infra` (`terraform fmt -check`, `validate`, `tflint` e `trivy config` no Terraform e nos Dockerfiles, sem credencial da AWS, sem `plan` e sem `apply`). (atualizado em 2026-10-31) O CI roda desde o PR #1 e está verde na `main`. O `test` roda sem `TEST_DB`, no modo Postgres, então os testes pulados no PGlite (seção anterior) rodam todos ali: no run 41211129511, da `main`, foram 414 e2e da API, sem nenhum pulado. O `audit` (`pnpm audit --prod --audit-level high`) só roda na `main`, no agendamento e no `workflow_dispatch`, e o `pnpm audit` só informa. Já o `scripts/audit-exceptions.mjs` falha o job, e também o `quality` de todo PR, se a exceção do GHSA-mrhx-c7xc-m3w5 (o `zod` do `@expo/cli`) mudar de caminho ou passar de 2026-11-30. Desde o PR #4, o `images` faz o build ARM64 das imagens, confere o usuário `node`, roda a migration pela imagem e espera `/health/ready` 200. No PR, ele só roda se o diff mexe no que entra nas imagens (job `changes`). Os services e o compose estão fixados por digest. O que o CI cobre e o que não cobre, caso a caso, está no `testes.md` §9.5, §10 e §10.9.

## Convenções

- **Commits**: Conventional Commits em pt-BR, `tipo(escopo): descrição`. Escopos: `mobile`, `api`, `worker`, `shared`, `ui`, `db`, `config`, `infra`, `docs`, `deps` e `repo`. O commitlint confere no hook `commit-msg`.
- **Branches**: curtas a partir da `main` (`feat/f0-...`), squash merge e tag `fase-N` depois da aprovação do PO.
- **Erros da API**: sempre `{ code, message, details? }` (`packages/shared/src/errors.ts`).
- Detalhes em [`docs/equipe/fase-0-plano.md` §6](docs/equipe/fase-0-plano.md).

## Documentação

[`docs/equipe/`](docs/equipe/): [`PROJETO.md`](docs/equipe/PROJETO.md) (consolidado), [`briefing.md`](docs/equipe/briefing.md) (especificação), [`arquitetura.md`](docs/equipe/arquitetura.md) e [`adr/`](docs/equipe/adr/), [`ux.md`](docs/equipe/ux.md), [`fase-0-plano.md`](docs/equipe/fase-0-plano.md), [`backlog.md`](docs/equipe/backlog.md), [`infra.md`](docs/equipe/infra.md) e [`testes.md`](docs/equipe/testes.md) (casos e checklists por fase). O protótipo fica em [`docs/design/prototipo/`](docs/design/prototipo/).

Produção (Fase 7): [`docs/deploy/runbook.md`](docs/deploy/runbook.md) (primeiro deploy, deploy de rotina, migrations, rollback, rotação de segredos, restauração e L3), [`docs/deploy/variaveis.md`](docs/deploy/variaveis.md) (de onde vem cada variável de produção), [`docs/deploy/lojas.md`](docs/deploy/lojas.md) (EAS, `eas submit` e checklist da App Store e da Google Play) e [`infra/terraform/README.md`](infra/terraform/README.md) (layout, porte e validação).

## Estado das fases

Formato de [`testes.md` §9.4](docs/equipe/testes.md). Prints em `docs/evidencias/fase-N/`.

| Fase | Estado                                                                                                                                                                                                                                                 | Data       | SHA                       | CI                 | EAS (Android / iOS)                             | Aparelhos e SO | Roteiros MAN-*                                         | Pendências              |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | ------------------------- | ------------------ | ----------------------------------------------- | -------------- | ------------------------------------------------------ | ----------------------- |
| 0    | ✅ Concluída com pendências de ambiente (iOS pendente aceito pelo PO, A-02); conferida pelo coordenador                                                                                                                                                | 2026-10-29 | 1771c0e (PR #1)           | ✅ verde na `main` | pendente / pendente                             | pendente       | MAN-APP-01: não executado                              | ambiente (lista abaixo) |
| 1    | ✅ Concluída com pendências de ambiente (lista abaixo); conferida pelo coordenador                                                                                                                                                                     | 2026-10-29 | 1771c0e (PR #1)           | ✅ verde na `main` | pendente / pendente                             | pendente       | MAN-AUTH-01: não executado                             | lista abaixo            |
| 2    | ✅ Concluída com pendências de ambiente (2a back-end e 2b app, listas abaixo); conferida pelo coordenador                                                                                                                                              | 2026-10-29 | 1771c0e (PR #1)           | ✅ verde na `main` | pendente / pendente                             | pendente       | MAN-UP-01, MAN-FEED-01: não executados                 | listas abaixo           |
| 3    | ✅ Concluída com pendências de ambiente (3a back-end e 3b app, listas abaixo); conferida pelo coordenador, o e2e da API, interrompido aqui por falta de memória, passa no CI                                                                           | 2026-10-30 | 1771c0e (PR #1)           | ✅ verde na `main` | pendente / pendente                             | pendente       | roteiro de aparelho da 3b: não executado               | listas abaixo           |
| 4    | 🟡 Implementada; **4e (2026-11-14, ADR 0013): conectar por NFC + QR code, sem Bluetooth** (branch `feat/conectar-nfc-qr`, ver "Fase 4e" abaixo). Kotlin compilado e com testes de JVM verdes (8/8); Swift não compilado; nada testado em aparelho      | 2026-11-19 | PR #12 (squash na `main`) | ✅ verde no PR #12 | pendente / pendente (dev build novo necessário) | pendente       | MAN-NFC-01 a 04, MAN-QR-01, MAN-CON-01: não executados | listas abaixo           |
| 5    | ✅ Concluída com pendências (5a back-end e 5b app, listas abaixo); remoção de GPS do vídeo só verificável depois do apply (A-21); conferida pelo coordenador (unitários, build, e2e da 5a)                                                             | 2026-10-30 | 1771c0e (PR #1)           | ✅ verde na `main` | pendente / pendente (dev build novo necessário) | pendente       | MAN-REEL-01: não executado; MID-14 pós-apply           | listas abaixo           |
| 6    | ✅ Concluída com pendências (6a back-end e 6b app, listas abaixo); push e Sentry sem contas (EAS/APNs/FCM/Sentry) nem aparelho; conferida pelo coordenador (unitários, build, expo-doctor, e2e direcionado da 6a)                                      | 2026-10-30 | 1771c0e (PR #1)           | ✅ verde na `main` | pendente / pendente (dev build novo necessário) | pendente       | MAN-PUSH-01: não executado                             | listas abaixo           |
| 7    | 🟡 Código pronto, sem `apply` (Terraform, Dockerfiles, runbook, lojas); `fmt`/`validate`/`tflint`/`trivy`, `plan` e build das imagens pendentes (sem terraform nem Docker aqui); D12 e L3 aguardam o PO; conferida pelo coordenador (unitários, build) | 2026-10-30 | 1771c0e (PR #1)           | ✅ verde na `main` | pendente / pendente                             | pendente       | regressão MAN-*: não executada                         | listas abaixo           |

Pendências de ambiente da Fase 0 (IDs de `testes.md` §10):

- **WSL2 e Docker** não instalados: F0-ENV-01, 02 e 06, F0-DC-01 a 07 (compose e spike S3/SQS), F0-Q-05 (`pnpm test:e2e`) e F0-API-02 a 04 (`/health/ready` com Postgres e Valkey reais). (atualizado em 2026-10-31) O CI cobre o F0-Q-05, o F0-API-02 e o compose do ElasticMQ e do SeaweedFS. Nesta máquina continuam os outros; o detalhe por ID está no `testes.md` §10 e §10.9.
- **LongPathsEnabled = 0**: F0-ENV-04. O `expo export` e o `expo prebuild` passaram mesmo assim.
- ~~**CI no GitHub** (D16): F0-CI-01 a 05.~~ (atualizado em 2026-10-31) O CI roda desde o PR #1. O F0-CI-01, o 03 e o 05 têm evidência; o F0-CI-04, só evidência natural (um e2e vermelho no PR #1). Falta o F0-CI-02 (PR negativo de propósito); ver `testes.md` §10.
- **Contas Expo e Apple e aparelhos físicos**: F0-APP-01 a 07 (dev builds, MAN-APP-01 e MAN-A11Y-01).
- **Cópia limpa testada por outra pessoa** (F0-DOC-01).

### Fase 4e: NFC + QR code, sem Bluetooth (ADR 0013), verificado × pendente

Pedido do PO em 2026-11-14. O "encostar" por BLE (ADR 0002 e 0012) saiu por inteiro. Agora:

- uma emissão traz um token só (`POST /proximity/tokens` → `{token, expiresAt, renewInS}`);
- o mesmo `sussurro://c/{token}` vai no QR e num registro NDEF;
- o Android emite por HCE (Type 4 Tag), só com a tela Conectar aberta, em primeiro plano, com o aparelho desbloqueado e por até 30 s por payload;
- Android e iPhone leem (reader mode e `NFCNDEFReaderSession`); o iPhone não emite e usa o QR;
- métodos `qr | nfc` (migration aditiva `0007`); o aceite sempre exige o código lido de quem pediu (D7);
- bloquear e denunciar valem para a outra pessoa de um pedido de conexão das últimas 24 h (Adendo B1).

Verificado em 2026-11-14 (Linux, Node 26.13.0, pnpm 12.13.0, sem Docker e sem aparelho): `pnpm format:check`, lint e typecheck, unitários de todos os pacotes, `pnpm build`, e2e PGlite de proximidade, conexões, rotas dev, canário de privacidade, rotas, notificações, bloqueios e denúncias, e integração do db. Os números estão no relatório da sessão.

Segunda rodada, também em 2026-11-14 (revisão de textos e de acessibilidade):

- O `ux-ui` revisou 84 textos do Conectar (`ux.md` §11.19). O PO aprovou tudo, e o `frontend` aplicou:
  - 10 trocas e as chaves novas `waitingEmitHint`, `acceptReadNfc`, `turnOnNfcHint` e `cameraDeniedTextAccept` (N28);
  - os achados de acessibilidade S1 a S7 (anúncio no VoiceOver, títulos, dicas, câmera negada no aceite);
  - o ícone `smartphone-nfc` dentro da tela. A aba continua com `radio` até o teste com usuários (decisão do PO).
- O `testes` definiu no `testes.md` §6.11 os casos NFC-01 a 24 e NFC-MOD-*, e no §8 os MAN-NFC-01 a 04. Os casos de BLE e de encosto ficaram marcados como obsoletos. Entrou o teste NFC-09 da câmera, com mutação verificada. Os IDs obsoletos saíram dos e2e da API.
- O `devops` tirou o BLE de `docs/deploy/lojas.md` e de `infra.md`: permissões, `NFCReaderUsageDescription`, entitlement `TAG`, nota ao revisor e Política de Privacidade. O `.gitignore` passou a ignorar a saída do Gradle e do Xcode dos módulos.
- O `seguranca` revisou o diff novo: sem CRÍTICO, ALTO nem MÉDIO. O único BAIXO (o texto do iOS no `lojas.md`) foi corrigido.
- A ADR 0013 foi alinhada ao código (IDs NFC e texto do iOS). O `backlog.md` E4 marca as histórias de BLE como histórico.
- Reconferido pelo Tech Lead: `pnpm format:check` ✅, lint e typecheck 15/15 ✅, unitários 6/6 pacotes ✅ (mobile 406, ui 229), `pnpm build` ✅. E2E PGlite de proximidade (18), conexões (38) e bloqueios (14) ✅ depois da limpeza dos IDs.
- Kotlin, também em 2026-11-14 (JDK 21 e Android SDK nesta máquina, projeto `apps/mobile/android` do prebuild, ignorado pelo Git): `./gradlew --offline :sussurro-proximity:testDebugUnitTest --rerun-tasks` compila o módulo e passa 8/8 (NFC-10 a 17). Um resultado antigo, das 03:52, tinha 2 falhas, de antes da última correção do `SussurroNdefService.kt`. O manifesto mergeado de debug (`:app:processDebugMainManifest`) não tem nenhuma permissão de Bluetooth nem de localização e traz `android.permission.NFC` e o `SussurroNdefService` com `BIND_NFC_SERVICE`. O de release não foi gerado, porque precisaria baixar dependências do Maven.

Pendente:

- **Dev build EAS novo** (o módulo nativo mudou): o Swift não foi compilado (sem Mac); o Kotlin compila aqui (ver acima). Faltam o `expo-doctor` (17 pacotes com versão minor atrás do SDK 58) e os roteiros em aparelho:
  - MAN-NFC-01: Android → Android, costas com costas;
  - MAN-NFC-02: Android → iPhone;
  - MAN-NFC-03: código apagado em background e depois de 30 s;
  - MAN-NFC-04: tag lida com o app fechado abre o cartão, sem pedido automático.
    No aparelho, conferir também: o gesto do iPhone (topo nas costas do outro), o anúncio S2 no VoiceOver e se dois Android em "Mostrar meu código" se leem pelo `NDEF_DISCOVERED` (`ux.md` §11.19).
- ~~**Testes Kotlin (NFC-10 a 17):** rodam aqui (8/8), mas não no CI, que não tem job Gradle.~~ (2026-11-19) Job `native` no CI (`infra.md` §4.1): prebuild de produção, `:sussurro-proximity:testDebugUnitTest` e o manifesto final de release. Revisado pelo `seguranca` (sem CRÍTICO nem ALTO; os 2 MÉDIO e os 4 BAIXO foram corrigidos). Verde no PR #12 (run 44635846785, commit 3d2e595): 8 min, `BUILD SUCCESSFUL`, manifesto de release com 35 permissões, todas na lista. Só a variante `production` passa pelo prebuild no CI; o `preview` cai no mesmo ramo do `app.config.ts` e é coberto pelo teste unitário (risco BAIXO aceito, apontado pelo `seguranca`).
- **Manifesto de release e permissões das lojas:** o manifesto traz também permissões de dependências (biometria do `expo-secure-store` e badges de launcher, agora na lista de permitidas); o dev build (variante `development`) traz ainda `SYSTEM_ALERT_WINDOW` e rede local para o servidor de desenvolvimento. (2026-11-19) O job `native` gera o manifesto final de release, e o `scripts/check-android-manifest.mjs` falha com qualquer permissão fora da lista de permitidas (a mesma da tabela do `lojas.md`, agora com as de biblioteca e a origem de cada uma); a lista completa sai no resumo do run. O primeiro run (2026-11-19) compilou o módulo, passou os testes Kotlin e achou `SYSTEM_ALERT_WINDOW` na release, vinda do template do prebuild. Ela agora sai em preview e produção (`ANDROID_RELEASE_BLOCKED_PERMISSIONS` no `app.config.ts`, com teste e mutação verificada) e fica só no dev build. `ACCESS_LOCAL_NETWORK` e `CHANGE_WIFI_MULTICAST_STATE` não aparecem na release. A checagem achou no de debug `READ_EXTERNAL_STORAGE` e `WRITE_EXTERNAL_STORAGE` com `maxSdkVersion="32"` (template do prebuild e `expo-file-system`), agora registradas no `lojas.md` como legado aceito. Falta conferir o AAB final (`bundletool dump manifest`), que sai do EAS.
- **Política de Privacidade publicada** (fora do repo, no site): se ainda cita Bluetooth ou localização, reescrever antes de enviar às lojas ("NFC só com a tela Conectar aberta, por até 30 s por código, ou a câmera para o QR code").
- **Ícone da aba Conectar:** `radio` até o teste com usuários (decisão do PO, 2026-11-14).
- **Matriz de aparelhos da 4e** (`testes.md` 8.1): proposta de mínimo de 2 Androids com HCE + 1 iPhone, para o PO decidir.

### Fase 1: verificado × pendente

Verificado em 2026-10-29, na máquina do PO (Windows 11, Node 26.13.0, pnpm 12.13.0), **sem Docker**:

- `pnpm check` verde: format, lint com 0 avisos, typecheck e unitários (shared 74, db 13, api 94, worker 18, ui 100, mobile 75). `pnpm build` verde. Conferido de novo pelo coordenador, sem cache (`pnpm check --force`, `pnpm build --force`, `TEST_DB=pglite pnpm test:e2e`); o teste do `Logo`, que só imprimia valores, passou a verificar a geometria e as cores do briefing.
- `TEST_DB=pglite pnpm test:e2e` verde, com as migrations reais do drizzle-kit:
  - db: 21 testes, 2 pulados (pool do `node-postgres`);
  - worker: 3 (hard delete, CONTA-05);
  - api: 63, 3 pulados (refresh concorrente entre conexões, script Lua do Valkey, F0-API-02).
- Casos cobertos:
  - AUTH-01 a 09, 11 e 12;
  - CONTA-01, 02 (perfil e login), 05, 06 e 07;
  - PERM-05 (guard), 06 (trigger e constraints de `users`), 07, 11, 12, 13 (dono, inexistente, excluída, sem permissão), 17 (log) e 18 (matriz de 401 lida das rotas registradas);
  - D6: esqueci a senha e confirmação de e-mail.
- No app: AUTH-10 (single-flight), AUTH-13 (só o refresh no armazenamento) e AUTH-14; navegação por tipo de conta (história 1.9 CA1 a CA4: o criador não vê Início, Pesquisar nem Conectar, nem por deep link); telas Entrar, Cadastro, Esqueci a senha, Redefinir, Verificar e-mail, Perfil, Editar perfil, Conta e Excluir conta, com os estados de erro e offline.
- API subindo de verdade (`node dist/main.js`) contra o `pnpm db:pglite`, com `pnpm db:migrate` (drizzle-kit) e `pnpm db:seed`. O roteiro com curl passou de ponta a ponta: cadastro → link de verificação no log → login → refresh → reuso detectado (401 e família revogada) → `GET /me` → editar → esqueci a senha → excluir (o @ continua bloqueado). Sem Valkey, `/health/ready` = 503 e o rate limit liberou com aviso no log.

Pendente:

- ~~**Com Docker** (WSL2 ainda não instalado): `pnpm test:e2e` no modo padrão (Postgres + Valkey), que inclui os 5 testes pulados no PGlite, e `pnpm db:migrate` no Postgres do compose.~~ (atualizado em 2026-10-31) Resolvido pelo CI, que roda as migrations e o `test:e2e` no Postgres 18.6 e no Valkey, sem nenhum teste pulado.
- ~~**CI remoto** (nada enviado ao GitHub).~~ (atualizado em 2026-10-31) Resolvido: o CI roda desde o PR #1 e está verde na `main`.
- **Dev build EAS novo** (entraram `expo-secure-store` e `expo-network`) e o roteiro MAN-AUTH-01 em aparelho: Android e iOS (conta Apple, A-02).
- **Envio real pelo SES**: só o código e o teste com o cliente simulado; a verificação depois do `apply` fica para a Fase 7.
- **Fora desta fase, por depender de tabelas futuras**: números do perfil (0 até as Fases 2 a 4), listas de conexões e criadores ao tocar nos números (Fases 3 e 4), perfil pessoal visível às conexões (Fase 4), bloqueio parcial de conta com e-mail não confirmado (rotas das Fases 2 a 4), páginas de Termos e de Política de Privacidade.

### Fase 2a: verificado × pendente

Back-end e contratos da Fase 2 (histórias 2.1 a 2.9 e 2.11, mais o back-end do avatar da 2.4). As telas ficam para a Fase 2b. Verificado em 2026-10-29, na máquina do PO (Windows 11, Node 26.13.0, pnpm 12.13.0), **sem Docker**:

- `pnpm check` verde: format, lint com 0 avisos, typecheck e unitários (shared 127, db 13, api 122, worker 27, ui 100, mobile 75). `pnpm build` verde (API, worker e o script `seed:media`).
- `TEST_DB=pglite pnpm test:e2e` verde, com as migrations reais do drizzle-kit (`0002_posts_media_likes_comments`):
  - db: 35 testes, 2 pulados (pool do `node-postgres`);
  - worker: 31, 2 pulados (DLQ no ElasticMQ e adaptador S3 no SeaweedFS);
  - api: 156, 7 pulados (os 3 da Fase 1 e 4 de S3/SQS reais: `Content-Length` maior, URL vencida, `publish` com HEAD e SQS, GET adulterado).
- Casos cobertos:
  - TXT-01 a 04 (fixtures compartilhadas em `@sussurro/shared/fixtures/text-count.json`, lidas pelo `shared` e pelo e2e da API);
  - MID-01 a 13, exceto as recusas que só o S3 de verdade faz (pulados no PGlite; o fake reproduz o contrato);
  - FEED-01 a 15 (FEED-14 e FEED-04 no lado da API; a tela é da 2b) e FEED-16 medido;
  - CNT-01, 04 (inclusive 50 curtidas em paralelo e o recálculo do A-12) e 05;
  - PERM-02 e 06 (FKs compostas de `connections` e `follows`), 10c, 12, 13 (agora também conexão → 200), 14, 15, 16 e 18 (as 15 rotas novas entram sozinhas na matriz de 401 e de schema);
  - CONTA-02 (feed e posts), 03 e 05 (objetos do S3 e contadores);
  - criador (A-06): curtir → 403; no próprio post, só responde e apaga; comentário de primeiro nível ou em post de outra conta → 403;
  - e-mail não confirmado (X.3): criar texto, rascunho, publicar e comentar → 403 `EMAIL_NOT_VERIFIED`; ler, curtir, perfil e conta liberados;
  - 2.11 CA2: dois executores da limpeza ao mesmo tempo apagam cada rascunho e cada objeto uma vez só.
- Worker com as fixtures geradas pelo sharp (`apps/worker/test/fixtures/media.ts`): JPEG com EXIF, GPS, XMP e IPTC, PNG e WebP com EXIF, GPS e XMP e JPEG com orientação de 90°. Todas as saídas (`full` 1080 px e `thumb` 360 px, JPEG q82) saem sem EXIF, XMP, IPTC nem ICC, sem os segmentos APP1, APP2 e APP13 e sem os valores marcados, e a foto girada sai em pé. HTML e SVG disfarçados de JPEG e o PNG de 30000×30000 px viram `failed` sem decodificar.
- API subindo de verdade (`node dist/main.js`) contra o `pnpm db:pglite`, com `pnpm db:migrate` e `pnpm db:seed`: roteiro de 29 passos OK (feed de texto e de foto com cursor, privacidade entre caio.r e marinac, post de texto, curtir duas vezes, comentar, responder, resposta de resposta → 400, `profileVisible`, os 403 do criador, os 404 idênticos, apagar comentário e post, URL PUT assinada). FEED-16 no PGlite, só como indicativo: p95 de 26,7 ms em 180 chamadas (650 autores, 100 mil posts).
- Itens que a Fase 1 deixou para as tabelas novas e que entraram agora: números do perfil (publicações, conexões, criadores e seguidores), perfil pessoal visível às conexões e o bloqueio parcial do e-mail não confirmado nas rotas da Fase 2.

Pendente:

- **Com Docker** (WSL2 ainda não instalado): ~~`pnpm test:e2e` no modo padrão, com os 11 testes pulados no PGlite (S3 e SQS reais, DLQ, pool do `node-postgres`); no Postgres de verdade, as 50 curtidas e os dois executores da limpeza disputam conexões diferentes do pool (`FOR UPDATE SKIP LOCKED`);~~ `pnpm --filter @sussurro/worker seed:media` no SeaweedFS; FEED-16 no Postgres 18. (atualizado em 2026-10-31) O CI resolveu a parte riscada (Postgres 18.6, Valkey, ElasticMQ e SeaweedFS, sem nenhum teste pulado). Falta o `seed:media`, que não tem teste, e o FEED-16, que é manual (`perf:feed`).
- ~~**CI remoto** (nada enviado ao GitHub).~~ (atualizado em 2026-10-31) Resolvido: o CI roda desde o PR #1, e o job `test` sobe o ElasticMQ e o SeaweedFS do compose.
- **CloudFront e lifecycle do S3** (Fase 7, depois do `apply`): o 403 do próprio CloudFront para URL adulterada (aqui a assinatura é conferida no teste com a chave pública) e a expiração de `incoming/` em 1 dia.
- **Aparelho** (Fase 2b, com as telas): MAN-UP-01 (foto real com GPS de iPhone e Android) e MAN-FEED-01.

### Fase 2b: verificado × pendente

Telas da Fase 2 (histórias 2.1 a 2.10 no app, mais a foto de perfil da 2.4, o bloqueio parcial do e-mail não confirmado nas telas e os links legais). Verificado em 2026-10-29, na máquina do PO (Windows 11, Node 26.13.0, pnpm 12.13.0), **sem Docker e sem aparelho**:

- `pnpm check` verde: format, lint com 0 avisos em todos os pacotes, typecheck e unitários (shared 127, db 13, api 122, worker 27, ui 165, mobile 144). `pnpm build` verde. `TEST_DB=pglite pnpm test:e2e` continua verde (db 35 + 2 pulados, worker 31 + 2, api 156 + 7, os mesmos da 2a). O contrato da API não mudou.
- `expo-doctor` 20/20. `expo export --platform android --platform ios` gera os dois bundles Hermes (`.hbc`).
- Telas:
  - **Início** (só pessoa): abas Fotos e Textos com paginação por cursor, puxar para atualizar, "Você está em dia" com o período de `feedWindowLabel(windowHours)`, EmptyState "Seu início está vazio" (sem conexões nem criadores), falha na 1ª página com "Tentar de novo", falha na página seguinte mantendo a anterior ("Não carregou. Tentar de novo") e cursor recusado recomeçando da 1ª página. Reels e o coração de notificações continuam como telas futuras (Fases 5 e 6).
  - **Posts**: `PostPhoto` (4:5, carrossel "1/3", setas, pontos centralizados) e `PostText` (thread); "Há 18 minutos" / "Ontem" / "27 out" e "40 min" / "3 h" / "ontem" sem `Intl`; "N curtidas" e "Ver todos os N comentários" no singular e no plural; curtida otimista com rollback e o Toast "Não foi possível curtir."; o criador não tem o coração como ação (A-06); detalhe `p/[id]` dentro da aba de origem; apagar o próprio post com confirmação (some do feed, do perfil e do detalhe na hora).
  - **Comentários**: folha `comentarios/[postId]` (formSheet no iOS, modal no Android) e lista no detalhe; comentar, responder (1 nível), apagar por pressão longa quando `canDelete`, envio otimista com "Não publicado. Tentar de novo"; o @ só é tocável com `profileVisible` (D11); o criador, no próprio post, só responde e apaga.
  - **Criar** (pessoa e criador): pílula FOTO/TEXTO/REEL (REEL desabilitado). TEXTO com o contador `postTextCounter`. FOTO com o seletor do sistema, grade numerada (a 5ª mostra "Até 4 fotos por publicação."), prévia 4:5, legenda, HEIC → JPEG de até 2160 px pelo `expo-image-manipulator`, rascunho → PUT de cada foto com os cabeçalhos assinados → `publish` → faixa "Publicando…" até `published` (Toast "Publicado.") ou `failed` ("Tentar de novo" e ✕). Offline: "Sem internet. Sua publicação não foi enviada."
  - **Perfil**: grade de fotos 3:4 e lista de textos com paginação; o dono vê os tiles em `processing` e `failed`; números reais; perfil de outra conta (`u/[handle]`) pelo `GET /users/:handle` + posts, com "Perfil indisponível" no 404.
  - **Editar perfil**: trocar a foto (upload → `PUT /me/avatar` até sair de `processing`) e remover (volta às iniciais sobre o pastel).
  - **E-mail não confirmado** (X.3): publicar e comentar mostram "Confirme seu e-mail para publicar e comentar." com a ação "Verificar e-mail", que leva à tela de reenvio; ler, curtir e editar o perfil seguem liberados.
  - **Links legais**: "Termos de uso" e "Política de privacidade" na Conta e no rodapé do Cadastro abrem `https://sussurro-site.vercel.app/termos` e `/privacidade` (constante em `apps/mobile/src/lib/legal.ts`, pelo `Linking`).
- Catálogo (`/dev/catalog`): seções "Posts e comentários" (todos os componentes novos, com estados) e "Telas compostas" (feed de fotos e de textos para comparar com p06 e p07), com as imagens de exemplo de `pnpm --filter @sussurro/mobile generate-catalog-images`.
- Casos cobertos no app: TXT-02 e TXT-03 (as fixtures compartilhadas passam pelo contador da tela), TXT-01h, MID-01 (limite e Toast), MID-01 a 03, 07 a 10 no fluxo de envio (dublês do seletor e do S3 em `src/test-utils/fake-media.ts`), MID-09, FEED-04, 06, 08 e 14, PERM-10c, PERM-13, 2.7 CA1 e CA5, 2.8 CA1, CA2 e CA4, 2.9 CA1, 2.4 CA1 e CA2, 2.10 CA1 e CA2 (formatação), A-06 e X.3.

Pendente:

- **Dev build EAS novo** (Android e iOS, conta Apple, A-02): entraram `expo-image`, `expo-image-picker` e `expo-image-manipulator`, módulos nativos que os builds anteriores não têm.
- **Aparelho**: MAN-UP-01 (4 fotos reais, HEIC de iPhone com localização; conferir com `exifr` que a imagem servida não tem GPS; 4G fraco e sair do app durante o envio; orientação das fotos depois do `expo-image-manipulator`) e MAN-FEED-01 (ordem, "Você está em dia", puxar para atualizar, offline e os tempos relativos no Hermes). Também o teclado dentro da folha de comentários (iOS) e no modal (Android).
- **Com Docker**: os mesmos pendentes da 2a (hoje só o `seed:media` e o FEED-16).
- **Fora desta fase**: deslizar entre as abas do feed (hoje só pelo toque), grade "Recentes" com a galeria inteira no Criar (pede acesso à biblioteca; hoje é o seletor do sistema, sem permissão), Seguir e Conectados no perfil de outra conta (Fases 3 e 4), ponto de não lidas no coração e notificações (Fase 6), Reels (Fase 5).

### Fase 3a: verificado × pendente

Back-end e contratos da Fase 3 (histórias 3.1 a 3.9, mais X.1 Denunciar e X.2 Bloquear, aprovadas no D5). As telas ficam para a Fase 3b. Verificado em 2026-10-30, na máquina do PO (Windows 11, Node 26.13.0, pnpm 12.13.0), **sem Docker**:

- `pnpm check` verde: format, lint com 0 avisos em todos os pacotes, typecheck e unitários (shared 147, db 13, api 139, worker 27, ui 165, mobile 144). `pnpm build` verde.
- `TEST_DB=pglite pnpm test:e2e` verde, com a migration nova do drizzle-kit (`0003_blocks_reports_creator_search`):
  - db: 41 testes, 2 pulados (pool do `node-postgres`);
  - worker: 31, 2 pulados (DLQ no ElasticMQ e adaptador S3 no SeaweedFS);
  - api: 209, 9 pulados (os 7 das fases anteriores e 2 novos: o cache de seguidores no Valkey e seguir e bloquear o mesmo par em paralelo em conexões diferentes do pool).
- Casos cobertos:
  - BUS-01 a 10 na API (BUS-05 com status, corpo e headers idênticos e a mediana do tempo em 30 amostras; BUS-11 é da tela, na 3b; a regra do "pronto para chamar" já está em `isCreatorSearchReady`, no `shared`);
  - PERM-01 a 05 (PERM-05 lê o módulo de cada rota e falha se uma rota de feed, busca ou seguir não tiver o guard), 08, 09 (inventário pelos schemas de resposta), 10 (canário com todas as rotas GET, quatro chamadores e bloqueios no seed), 10b (todas as rotas que não são GET estão classificadas: chamadas ou dispensadas com o motivo), 11 (snapshot dos schemas públicos), 13, 14 e 16;
  - CNT-02 e 03 (seguidores com cache de 60 s; "criadores" e conexões na hora), FEED-01 e FEED-11 (seguir e deixar de seguir pela API, inclusive com o cursor antigo);
  - 3.6 CA1 a CA6 (CA5: a regra de lint tem teste próprio); 3.8 com as relações reais do seed (`seed-privacy.e2e-spec.ts`);
  - X.1 CA1 (mais idempotência, o próprio conteúdo → 400, rate limit e o e-mail para a moderação); X.2 CA1 a CA4, mais o bloqueio sem oráculo e pelo comentário.
- CA7 (3.7), demonstrado localmente: cada regra abaixo foi removida, os testes que a cobrem rodaram e falharam, e a mudança foi desfeita.
  - Bloqueio fora de `isProfileVisible` → 3 unitários da política e 2 e2e (busca e perfil, inclusive o bloqueio do seed).
  - Bloqueio fora de `isFollowAllowed` → 1 unitário e X.2 CA2.
  - Filtro de bloqueio das listas (comentários e busca) → 3 e2e de X.2.
  - Gravar o bloqueio sem ver o perfil (oráculo) → o teste A-05.
  - Busca sem o filtro de tipo de conta → BUS-04 e BUS-05.
  - Busca sem rate limit → A-31.
  - `PUT /creators/:handle/follow` sem o guard → PERM-01 e PERM-05.
  - Listas aceitando parâmetro a mais → PERM-08.
  - Listas com contas excluídas → 3.6 CA6.
  - A bio do perfil levando o @ do primeiro criador seguido → o canário (PERM-10).
  - Uma rota GET sem fixture no canário → 3.7 CA2.
  - Resposta a um comentário escondido pelo bloqueio → o teste de comentários de X.2.
  - Um import do `OwnListsRepository` no `feed.service.ts` → o ESLint do pacote falha com a mensagem da regra (CA5).
- API subindo de verdade (`node dist/main.js`) contra o `pnpm db:pglite`, com `pnpm db:migrate` e `pnpm db:seed` (rodado duas vezes, sem duplicar): roteiro de 32 passos OK.
  - Busca: `estu` acha só os dois estúdios; @ pessoal exato = `{"items":[]}` idêntico ao de um @ inexistente; 2 letras e `%` → 400; criador → 403; @estudante não acha @trilhasdosul (bloqueio do seed).
  - Seguir: o post do criador entra no feed na hora e sai ao deixar de seguir; @ pessoal → 404 idêntico ao inexistente.
  - Listas próprias e `?userId=` → 400.
  - Bloquear: @caio.r recebe o 404 de inexistente no perfil de @helena; a conexão foi desfeita; bloquear um @ inexistente dá o mesmo 204.
  - Denunciar: 202, repetido sem segundo e-mail, e a linha `E-mail (dev) para moderacao@example.com: "Denúncia de conta: Spam ou golpe (…)"` no log.
  - Sem Valkey, o rate limit e o cache de seguidores liberam com aviso no log; nenhum erro 500.

Pendente:

- ~~**Com Docker** (WSL2 ainda não instalado): `pnpm test:e2e` no modo padrão, com os 2 testes novos pulados no PGlite (cache no Valkey e a corrida entre seguir e bloquear em conexões diferentes).~~ (atualizado em 2026-10-31) Resolvido pelo CI. No Postgres, a ordem alfabética da busca é a da collation "C" (o índice e o `ORDER BY` usam `COLLATE "C"`, então não dependem do locale do banco).
- ~~**CI remoto** (nada enviado ao GitHub).~~ (atualizado em 2026-10-31) Resolvido: o CI roda desde o PR #1 e está verde na `main`.
- **Telas (Fase 3b)**: Pesquisar (BUS-11 e a dica do A-04), Seguir/Seguindo no perfil de criador, perfil próprio do criador (3.5), listas próprias ("Só você vê esta lista."), menu ⋯ com Denunciar e Bloquear, lista de bloqueados e os roteiros em aparelho.
- **Fora desta fase**: o pedido de conexão recusado por bloqueio (a regra já está em `AccessPolicyService.canRequestConnection`; as rotas são da Fase 4), painel de moderação e ações sobre a denúncia (hoje só o e-mail e o banco).

### Fase 3b: verificado × pendente

Telas da Fase 3 (histórias 3.1 a 3.6 e 3.9 no app, mais X.1 Denunciar e X.2 Bloquear). Verificado em 2026-10-30, na máquina do PO (Windows 11, Node 26.13.0, pnpm 12.13.0), **sem Docker e sem aparelho**. O contrato da API não mudou e nada foi acrescentado ao `packages/shared`.

- `pnpm check` verde, rodado em partes por causa da memória (o mesmo que o script faz): `pnpm format:check`; `pnpm turbo run lint typecheck --concurrency=1` (15 tarefas, lint com 0 avisos); testes de api, worker, shared e db pelo turbo (iguais aos da 3a: api 139, worker 27, shared 147, db 13); Jest com `--maxWorkers=2` em ui (173) e mobile (179). `pnpm build --concurrency=1` verde. `expo-doctor` 20/20. Nenhuma dependência nova.
- Telas:
  - **Pesquisar** (p15, só pessoa): `SearchBar` "Pesquisar @criador" (o "@" inicial é ignorado), pausa de 300 ms na digitação, sem sugestões ("Digite o @ de um criador."), "Digite pelo menos 3 letras." com 1 ou 2 letras **sem chamar a API** (`isCreatorSearchReady`, BUS-11) e a mesma mensagem para qualquer busca sem criador (A-04). Itens com avatar, nome, @, seguidores e Seguir/Seguindo; o item abre o perfil dentro da aba Pesquisar. Erro e 429: linha com a mensagem e "Tentar de novo".
  - **Seguir/Seguindo** (3.3): otimista na busca, no perfil e na lista, com rollback e Toast na falha de rede, 404 e 429; o número de "criadores" do próprio perfil muda na hora e o `GET /me` acerta depois. O número de seguidores do criador não muda na hora (cache de 60 s no servidor).
  - **Perfil de criador visto por pessoa** (p17): publicações e seguidores (sem toque), nome, "Criador de conteúdo · não segue ninguém", bio, Seguir/Seguindo e o menu ⋯. A rota `u/[handle]` existe nas abas Início, Pesquisar e Perfil e mantém a aba de origem ativa. O criador vendo outro criador não tem Seguir.
  - **Perfil próprio do criador** (p19): "Editar perfil" e "Nova publicação" já vinham da 2b; seguidores sem toque e sem menu ⋯ (agora com teste).
  - **Listas próprias** (3.6): no perfil pessoal, "conexões" e "criadores" abrem `/pessoal/perfil/conexoes` e `/pessoal/perfil/seguindo`, com "Só você vê esta lista.", paginação por cursor, "Tentar de novo" e EmptyState com "Conectar ao vivo" (leva à aba Conectar da Fase 4) ou "Pesquisar criadores". Em "Criadores que sigo", (Seguindo) pede confirmação e a linha some na hora.
  - **Início** (3.9): "Pesquisar criadores" do EmptyState já levava a `/pessoal/pesquisar`; agora abre a busca de verdade (teste ampliado).
  - **Menu ⋯** (D-UX14): nos posts e nos perfis de outras contas, "Denunciar" antes de "Bloquear"; no próprio post continua só "Excluir publicação". Nos comentários de outras contas, os dois itens entram na pressão longa (e nas ações do leitor de tela). O menu é o componente novo `ActionSheet` (`packages/ui`), porque o `Alert` do Android mostra no máximo 3 botões; a pressão longa dos comentários da 2b passou a usá-lo.
  - **Denunciar** (X.1): modal `/denunciar` com os 8 motivos de `REPORT_REASON_LABELS` (obrigatório), detalhes opcionais com contador até 500, "A pessoa denunciada não é avisada." e o Toast "Denúncia enviada. Obrigado por avisar." 404 fecha com "não está mais disponível"; 429 e falha de rede mantêm o formulário.
  - **Bloquear** (X.2): Alert que explica o efeito; o comentário bloqueia pelo `commentId`. Depois do 204, sai do perfil, e os posts, comentários e itens da busca e das listas da conta somem das listas já carregadas, sem recarregar. **Conta → Contas bloqueadas** (pessoa e criador): @ e data, "Desbloquear" com Alert que avisa que conexão e follows não voltam.
- Componentes novos no `packages/ui` (e no catálogo, seção "Busca, seguir e menus"): `SearchBar`, `UserRow` e `ActionSheet`; `ProfileHeader` ganhou Seguir/Seguindo e o ⋯ no modo "outra conta"; `RadioOptionList` aceita começar sem escolha.
- Casos cobertos no app: BUS-03, 09, 10 e 11; 3.1 CA2, CA3 e CA8; 3.2 CA1; 3.3 CA1, CA5 e CA6; 3.4 CA1 e CA2; 3.5 CA1; 3.6 CA1; 3.9 (ação do EmptyState); X.1 CA1 no app; X.2 (bloquear pelo perfil, pelo post e pelo comentário, lista e desbloquear); 1.9 (o criador não tem Pesquisar nem as listas, nem por deep link).

Pendente:

- **Aparelho** (Android e iOS, com o dev build da 2b; a 3b não trouxe módulo nativo): roteiro manual de busca, seguir, perfil de criador, listas, denunciar e bloquear. Conferir em especial o menu ⋯ (`ActionSheet`, `Modal` do React Native) por cima da folha de comentários no iOS e o Alert de bloquear logo depois de o menu fechar.
- ~~**Com Docker** e **CI remoto**: os mesmos pendentes da 3a.~~ (atualizado em 2026-10-31) Resolvidos pelo CI.
- **Fora desta fase**: "Desfazer conexão" na lista de conexões (D8, Fase 4); o Início não recarrega sozinho depois de seguir ou deixar de seguir (os posts entram e saem ao puxar para atualizar; o bloqueio some na hora).
- **Divergências do protótipo**: p06, p07 e p17 não têm o ⋯ de outras contas (D-UX14 pede); nos comentários o menu é a pressão longa (ux.md §4.3), sem ícone ⋯ por linha; a entrada "Contas bloqueadas" e a tela Denunciar não têm wireframe no ux.md (§4.7 e §4.8 foram a base).

### Fase 4a: verificado × pendente

Back-end e contratos da Fase 4 (histórias 4.2, 4.4 no servidor, 4.5, 4.6, 4.8, 4.9, 4.10 e 4.11; decisões D3, D7, D8, D13 e D15). As telas, o QR e o módulo BLE nativo (4.1, 4.3, 4.4 no app e 4.7) ficam para a Fase 4b. Verificado em 2026-10-30, na máquina do PO (Windows 11, Node 26.13.0, pnpm 12.13.0), **sem Docker e sem aparelho**:

- `pnpm check` rodado em partes por causa da memória: `pnpm format:check`; `pnpm turbo run lint typecheck --concurrency=1` (15 tarefas, lint com 0 avisos); unitários pelo turbo com `--maxWorkers=2` (shared 159, db 13, api 150, worker 27, ui 173, mobile 179). `pnpm build --concurrency=1` verde. Nenhuma dependência nova.
- E2E com `TEST_DB=pglite` e um worker, só nos arquivos novos, alterados e de permissão afetados (o `pnpm test:e2e` inteiro não cabe na memória desta máquina):
  - api: `proximity` 14, `connections` 32, `dev-routes` 6, `routes` e `privacy-canary` 16; `blocks`, `auth`, `account-deletion`, `seed-privacy`, `own-lists`, `feed` e `me` 81; `real-services` com 6 pulados (os 4 das fases anteriores e 2 novos: o adaptador Redis da proximidade no Valkey);
  - db: `connections-schema` (novo, 4), `seed`, `schema` e `posts-schema`, 39 no total;
  - worker: `maintenance` 7 (1 novo: pedidos vencidos e retenção de 30 dias).
- Migration nova do drizzle-kit: `0004_connection_requests` (tabela `connection_requests`, enum `request_status`, um pendente por par pelo índice único parcial e a FK de `connections.request_id` com `ON DELETE SET NULL`).
- Rotas novas, todas só de conta pessoal (criador → 403 `ACCOUNT_TYPE_NOT_ALLOWED`, 4.8 CA1), com o contrato em `packages/shared` (`proximity.ts` e `connections.ts`) e na `arquitetura.md` §13:
  - `POST /v1/proximity/tokens` e `POST /v1/proximity/resolve`;
  - `POST /v1/connections/requests`, `GET .../incoming`, `GET .../:id`, `POST .../:id/accept`, `POST .../:id/decline` e `DELETE .../:id`;
  - `DELETE /v1/connections/:handle` (desfazer conexão, D8);
  - `POST /v1/dev/simulate-request`, registrada só com `NODE_ENV=development`.
- Casos cobertos:
  - PROX-01 a 23 (PROX-13 com 50 rodadas), 25 (o lado do servidor: uma linha por pessoa, com o token mais recente), 26, 27 e 30. Sem `sleep`: o relógio de teste controla os 30 e 120 s dos tokens e do pedido;
  - PERM-05 (proximidade e conexões), PERM-09, PERM-10 e 10b com as rotas novas e os canários `canary_req_in_*` e `canary_req_out_*`, PERM-11 (snapshot dos schemas novos), CNT-03, FEED-11 e PERM-13 ao desfazer conexão;
  - X.2 CA2 (com bloqueio, o pedido recebe a mesma mensagem genérica) e CA3 (bloquear cancela o pedido pendente do par); X.3 (emitir token, pedir e aceitar exigem e-mail confirmado; recusar, não);
  - A-17: 3 pessoas por perto resolvendo cada token novo na hora e 10 pessoas em lote a cada 3 s, por 5 min, sem nenhum 429.
- CA3 da 4.10, demonstrado localmente: 37 regras removidas uma a uma por um script, que rodou os testes e restaurou cada arquivo (conferido por SHA-256). 36 derrubaram pelo menos um teste:
  - tokens: validade de 30 s no pedido, janela de 120 s no aceite, só o hash no Redis, 12 bytes, tela aberta no resolve, no pedido e no aceite;
  - pedido e aceite: pedido a si mesmo, token cruzado no aceite (inclusive o QR cruzado), corrida A→B ∥ B→A, pendente único, expiração de 120 s, intervalo de 1 h depois da recusa, bloqueio, já conectados, aceite idempotente, aceite só de pendente;
  - limites: tokens, resolve, pedidos, aceites e o bloqueio depois de 20 falhas; fail-closed sem Redis;
  - logout e exclusão de conta; terceiro sem acesso ao pedido; só B aceita e recusa e só A cancela; o resolve sem o próprio chamador, sem bloqueio e com o token mais recente; o guard de criador; o e-mail confirmado; `/dev` só em desenvolvimento; desfazer com 404 idêntico; o bloqueio cancelando o pendente; "não confirmado" para quem pediu.
  - A exceção é a trava do par (`lockAccountPair`) no pedido: no PGlite as transações já são serializadas, então tirá-la não muda nada. Ela só é posta à prova pela corrida do PROX-13 no Postgres de verdade (pendente, abaixo).
- API subindo de verdade (`node dist/main.js`) contra o `pnpm db:pglite`, com `pnpm db:migrate` e `pnpm db:seed` (rodado duas vezes, sem duplicar), em development e com `PROXIMITY_STORE=memory`. Roteiro de 35 chamadas OK, nenhum 5xx:
  - @caio.r e @marinac pedem token e resolvem um ao outro; o pedido de caio.r chega na caixa de entrada de marinac; o aceite sem `observedToken` dá 400 e com o token de caio.r conecta;
  - o polling de caio.r vê `accepted`; a conexão aparece nas duas listas e o post de marinac no feed de caio.r;
  - caio.r desfaz: o post some do feed, o perfil dá 404 e repetir dá o 404 de "Conexão não encontrada";
  - @cozinhadabia (criadora) recebe 403 em tokens, resolve, pedido, caixa de entrada e desfazer;
  - `/v1/dev/simulate-request`: @lucasf pede para @estudante, que aceita com o token devolvido e passa a ver o post dele; @tomas por QR para marinac, que recusa;
  - o logout de caio.r revoga o token dele.
  - Com `PROXIMITY_STORE=redis` e sem Valkey: tokens, resolve e pedido dão 503 `PROXIMITY_UNAVAILABLE` em até ~0,5 s; login, feed, `/me`, caixa de entrada e logout respondem normalmente.

Pendente:

- ~~**Com Docker** (WSL2 ainda não instalado): `pnpm test:e2e` no modo padrão, com os 2 testes novos do adaptador Redis no Valkey e a corrida do PROX-13 em conexões diferentes do pool, que é a prova da trava do par.~~ (atualizado em 2026-10-31) Resolvido pelo CI, sem nenhum teste pulado.
- ~~**CI remoto** (nada enviado ao GitHub).~~ (atualizado em 2026-10-31) Resolvido: o CI roda desde o PR #1 e está verde na `main`.
- **Fase 4b**: tela Conectar (seletor "Bluetooth / QR code", radar, "Por perto agora" com as faixas do D13, aguardando, folha do pedido, conectados, p-22), QR cruzado (PROX-24), módulo BLE nativo e o spike da 4.1 com aparelhos (PROX-28, MAN-BLE-01 a 05, MAN-QR-01, MAN-CON-01), "Desfazer conexão" no app, o botão "Simular um pedido recebido" só com `EXPO_PUBLIC_DEV_TOOLS=1`, as mensagens dos códigos novos (já mapeadas em `apps/mobile/src/lib/error-messages.ts`).
- **Fase 6**: PROX-29 (notificação `connection_created` para os dois) e o push do pedido (6.6).
- **Política de Privacidade** (`C:\dev\sussurro-site`, `/privacidade`): descrever os dados novos (tokens efêmeros e pedidos de conexão, com prazos), conforme o relatório da Fase 4a.

### Fase 4b: verificado × pendente

App da conexão presencial (histórias 4.3, 4.4, 4.5, 4.6 e 4.7 no app, 4.8 CA2, 4.9 e 4.11 CA3; decisões D1, D3, D7, D8, D13 e D15). Verificado em 2026-10-30, na máquina do PO (Windows 11, Node 26.13.0, pnpm 12.13.0), **sem Docker, sem Mac, sem JDK/Android SDK e sem aparelho**. O back-end e o `packages/shared` não mudaram.

- `pnpm check` rodado em partes: `pnpm format:check`; `pnpm turbo run lint typecheck --concurrency=1` (15 tarefas, lint com 0 avisos); unitários com `--maxWorkers=2` (shared 159, db 13, api 150, worker 27, ui 184, mobile 244). `pnpm build --concurrency=1` verde. `expo-doctor` 20/20.
- Dependências novas: `expo-camera` 58.0.14 no app (`npx expo install`) e `qrcode-generator` 2.0.4 no `packages/ui` (só JS, sem dependências), no lugar do `react-native-qrcode-svg` (ver "Decisões").
- **Módulo `apps/mobile/modules/sussurro-proximity`** (Expo Modules API, ADR 0002), Swift (CoreBluetooth) e Kotlin (`BluetoothLeAdvertiser`/`BluetoothLeScanner`):
  - anuncia só o UUID de serviço de 128 bits (`53555353` + os 12 bytes do token), sem nome local nem do aparelho, sem GATT (no Android, não conectável); o token novo troca o anúncio sem parar antes;
  - varre filtrando o prefixo (Android: `ScanFilter` com máscara; iOS: sem filtro em primeiro plano, filtro em código, duplicados ligados) e emite `{uuid, rssi}`, no máximo 1 evento por UUID a cada 0,5 s. Nunca conecta nem guarda o aparelho visto;
  - `getCapabilities` (BLE, Bluetooth ligado, permissão, anúncio), `requestPermission`, "Ligar Bluetooth" (Android) e a tela acesa enquanto procura ou aguarda (no próprio módulo, sem `expo-keep-awake`);
  - para tudo em background (`OnAppEntersBackground`/`OnActivityEntersBackground`) e ao sair da aba;
  - camada TypeScript: token ↔ UUID pelos helpers do `@sussurro/shared` (4.3 CA6, com testes), um rádio "indisponível" quando o nativo não existe (Expo Go, dev build antigo) e um rádio falso para os testes;
  - autolinking conferido com `expo-modules-autolinking resolve`: pod `SussurroProximity` (classe `SussurroProximityModule`) e projeto Android `sussurro-proximity`.
- **Config plugin** (`modules/sussurro-proximity/app.plugin.js`) conferido com `expo prebuild --no-install --clean` (só Android: no Windows o prebuild não gera o iOS; o `Info.plist` foi conferido com `expo config --type introspect`). As pastas geradas foram apagadas (CNG, já no `.gitignore`):
  - `AndroidManifest.xml`: `BLUETOOTH_SCAN` com `usesPermissionFlags="neverForLocation"`, `BLUETOOTH_ADVERTISE` e `BLUETOOTH_CONNECT`; `ACCESS_FINE_LOCATION`, `BLUETOOTH` e `BLUETOOTH_ADMIN` com `maxSdkVersion="30"` (só Android ≤ 11); `CAMERA`; `RECORD_AUDIO` bloqueada (`tools:node="remove"`); `uses-feature bluetooth_le` com `required="false"`. Nenhuma localização aproximada nem em background;
  - `Info.plist`: `NSBluetoothAlwaysUsageDescription` e `NSCameraUsageDescription` em pt-BR; sem `NSMicrophoneUsageDescription` e sem `UIBackgroundModes`.
- **Tela Conectar** (p10 a p14, ux.md §5.2), montada só com a aba em foco:
  - seletor "Bluetooth / QR code" (D3); "Procurar por perto" pede a permissão só no toque, depois da explicação do §4.12; radar com anéis animados (estático com "Reduzir movimento");
  - "Por perto agora" ordenada pelo sinal suavizado, com "bem perto" (acima de -60 dBm) e "por perto" (até -90; abaixo, a pessoa não aparece); quem já é conexão tem "Conectados" no lugar do botão; o RSSI nunca sai do aparelho (o `resolve` leva só os tokens, em lote, no máximo a cada 3 s);
  - token pedido ao abrir e renovado a cada `renewInS` (20 s), sem piscar no anúncio nem no QR; 20 s sem ninguém → "Ninguém por perto ainda" com o QR, e a varredura continua;
  - pedido com o token mais recente da pessoa (PROX-25); "Aguardando Caio confirmar" com polling de 2 s, "Cancelar pedido", "Caio não confirmou" com "Tentar de novo" e "Conectados" (p14); 409 → "Vocês já estão conectados."; pessoa que parou de anunciar → a linha some com "Caio saiu de perto. Procure de novo."; token recusado com a pessoa por perto → a mensagem genérica do §5.2;
  - estados: Bluetooth sem permissão, desligado (ao ligar, a busca começa sozinha), aparelho que não anuncia ("Procurar mesmo assim" só varre), Bluetooth indisponível, "Muitas tentativas" (429), "Conectar está indisponível agora" (503), "Sem internet" e e-mail não confirmado (sem pedir token);
  - em background tudo pausa (token, polling, anúncio e varredura) e recomeça ao voltar, no mesmo estado (4.3 CA3); ao sair da aba, a volta começa no Inicial.
- **Pedido recebido** (4.6): polling de 2 s com a tela aberta; folha "Helena quer se conectar" com avatar, @, nome, "Aceitar", "Recusar" e "Expira em 1:45" (não anunciado a cada segundo); uma por vez; o aceite manda o token mais recente de Helena visto na varredura (a folha de um pedido por Bluetooth liga a varredura, sem anúncio, se a permissão já existir; PROX-26); 410 e o fim do prazo fecham a folha com "O pedido de Helena expirou.".
- **QR** (4.7, D7): aba "QR code" com o meu QR (`sussurro://c/{token}`, correção M) e o meu @; "Ler o código dela" com `expo-camera` (só QR); a leitura passa pelo `resolve` antes de pedir (QR vencido ou adulterado: mensagem amigável e nada criado, sem contar falha de token); pedido com `method: 'qr'`; no "Aguardando" por QR, o meu código fica na tela para a outra pessoa ler; quem recebe um pedido por QR só aceita lendo o QR de quem pediu ("Ler código para aceitar"; o código de outra pessoa é recusado no app); câmera negada → "Câmera sem permissão" com "Abrir Ajustes" e "Mostrar meu código"; deep link `sussurro://c/{token}` (rota `c/[token]`): logada, segue o fluxo QR na aba Conectar; sem sessão, o token fica só em memória e é descartado depois de 30 s.
- **Criador** (4.8 CA2): o deep link do QR e `/pessoal/conectar` levam ao p22 ("Indisponível para criadores" e "Voltar ao perfil"), na rota `criador/conectar`, sem chamar a API.
- **Desfazer conexão** (4.9, D8): no "···" de cada linha de "Conexões" e no botão "Conectados" do perfil de uma conexão (ux.md §4.8 e §4.9), com Alert; a linha some na hora, o número de conexões cai, as publicações da pessoa saem das listas carregadas e tudo volta se a API falhar.
- **Simular um pedido recebido** (4.11): só com `__DEV__` e a variante `development` (nunca em `preview`/`production`, nem com `EXPO_PUBLIC_DEV_TOOLS=1`); usa `/v1/dev/simulate-request` e aceita com o `observedToken` devolvido.
- Componentes novos no `packages/ui` (e no catálogo, seção "Conectar"): `SegmentedControl`, `Radar`, `PairAvatars` e `QRCodeCard`; `ProfileHeader` ganhou "Conectados"; `UserRow` aceita o avatar 48.
- Casos cobertos no app: 4.3 CA3, CA4, CA5 e CA6; 4.4 CA1, CA4, CA5 (PROX-25), CA6, CA8 e CA9; 4.5 CA1, CA4, CA7, CA8 e CA9; 4.6 CA1, CA2, CA3, CA6, CA7 (PROX-26) e CA10; 4.7 CA1 a CA6 (PROX-24 e o QR cruzado); 4.8 CA2; 4.9 CA1; 4.11 CA1 e CA3; A-17 (resolve em lote); 4.2 CA3 e CA5 no app.

Decisões (onde os documentos eram omissos; o mais conservador em privacidade):

- QR com `qrcode-generator` (zero dependências) e desenho próprio em `react-native-svg`, em vez do `react-native-qrcode-svg`, que traz `text-encoding` (sem manutenção) e `qrcode` (com `yargs` e `pngjs`) e teve 20 versões em 4 dias.
- Anúncio só depois do toque em "Procurar por perto" (ou no "Aguardando" por Bluetooth); com a tela só aberta, o app pede o token (a marca de "tela aberta" do servidor) mas não anuncia. A folha de um pedido por Bluetooth só varre, sem anunciar e sem pedir permissão.
- Textos sem documento: "Bluetooth indisponível neste celular", "Confirme seu e-mail para se conectar", a mensagem do QR vencido ou adulterado, "Este código não é de Helena…", "O pedido de Helena não está mais disponível." (cancelado por quem pediu), o aviso de aceite sem ter visto o anúncio e o "Você desfez a conexão com @…".
- A folha do pedido tem um ✕ (e o voltar do Android) que fecha sem responder: o pedido segue valendo até vencer. "Recusar" é sempre explícito.
- O deep link sem sessão guarda o token só em memória (não no aparelho).

Divergências do protótipo e dos documentos:

- Folha do pedido e câmera dentro da tela Conectar (`Modal`), e não as rotas `conectar/pedido/[id]` e `conectar/ler-qr` do ux.md §3.2: assim a tela continua "aberta" no servidor durante a leitura e o aceite.
- Sem artigo antes do nome ("Confirme só se Helena…", "O pedido de Helena expirou."): o app não sabe o gênero da pessoa (o ux.md usa "a Helena", "da Helena").
- Em background a tela pausa e recomeça no mesmo estado (4.3 CA3), e não volta ao Inicial como diz o ux.md §5.2 (no Android, até o pedido de permissão manda o app para o background).
- Sem o "S•" no centro do QR (o ux.md §4.10 sugere): com correção M, o logo tiraria margem de leitura. Sem haptics (o `expo-haptics` não foi adicionado).
- O "✓" de "Conectados" fica antes do texto (o `Button` só tem ícone à esquerda). O botão "Simular um pedido recebido" do p10 só existe em dev (D15); "a ~1 m" virou "bem perto"/"por perto" (D13); "NFC / Bluetooth" virou "Bluetooth / QR code" (D3).

Pendente:

- **Não compilado nem testado**: o Swift e o Kotlin do módulo (não há Mac, JDK nem Android SDK aqui). Precisam de um **dev build novo do EAS** (Android e iOS): a 4b trouxe o `expo-camera` e o módulo local.
- **Aparelhos** (matriz do `testes.md` §8.1, dois iPhones para iOS↔iOS): o spike da 4.1 (descoberta em menos de 10 s por par, MAN-BLE-01), MAN-BLE-02 a 05, MAN-QR-01, MAN-CON-01, PROX-28 com o nRF Connect (sem nome, só o UUID, troca a cada 20 s, para em background) e o PROX-24 em aparelho. Conferir em especial: o iPhone conectável por terceiros expõe o nome GAP do aparelho?; no Android ≤ 11 a varredura exige a localização do sistema ligada (o app não avisa); Android 12+ com `neverForLocation` filtra beacons (o nosso anúncio não é beacon); o `Modal` da folha e da câmera por cima da tab bar no iOS.
- ~~**Com Docker** e **CI remoto**: os mesmos pendentes da 4a.~~ (atualizado em 2026-10-31) Resolvidos pelo CI.
- **Política de Privacidade** (`C:\dev\sussurro-site`): Bluetooth, câmera e os dados da Fase 4, conforme o relatório da 4b.

### Fase 4c: "encostar os celulares" (ADR 0012, adendos A1 e A2): verificado × pendente

Revisão do D3 pelo PO: conectar **encostando os celulares** (Bluetooth de curtíssimo alcance com observação mútua no servidor) e QR de reserva; o radar e a lista "Por perto agora" saíram. Desenho em `docs/equipe/adr/0012-conectar-encostando.md` (com os adendos A1, A2 e A2 rev. 1), `docs/equipe/arquitetura.md` §11 e `docs/equipe/ux.md` §11 (textos T1 a T46). Verificado em 2026-10-30, na máquina do PO (Windows 11, Node 26.13.0, pnpm 12.13.0), **sem Docker e sem aparelho**:

- `pnpm format:check`; `pnpm turbo run lint typecheck --concurrency=1 --force` (15 tarefas); unitários com `--maxWorkers=2`: shared 227, db 13, api 310, worker 73, ui 228, mobile 457; `pnpm build` (4 tarefas); `npx expo-doctor` 20/20.
- E2E no PGlite, direcionado: 166 do agente `testes` (proximity, proximity-touch, proximity-card-actions, privacy-canary, connections, dev-routes, blocks, reports, notifications, routes, own-lists e db-error-privacy) e 119 da reconferência do coordenador. O `real-services` (scripts Lua contra o Valkey, PROX-56) só roda no CI.
- Mutação: 76 de 78 mutantes mortos no servidor (os 2 sobreviventes estão no Lua, que só o CI executa) e as mutações do app pegas pelos testes.
- **Servidor**: dois tokens por emissão (`bleToken` e `qrToken`, canais separados); `resolve` só aceita QR; `POST /v1/proximity/touches` (1 token por chamada, 60/min) com encosto mútuo numa janela de 5 s contada do primeiro relato (prazo deslizante); par encostado de 60 s; teto de **10 pessoas novas por hora e 30 por dia** por conta (decisão do PO); **revelação simétrica garantida** (o cartão de quem casou fica guardado e é entregue ao outro lado mesmo com bloqueio, exclusão ou logout logo depois); "uma pessoa por vez"; `pairExpiresInS` em múltiplos de 5 s; bloquear e denunciar pelo @ com o par vivo (o perfil pessoal só é visível às conexões); sinal à moderação depois de 3 bloqueios logo após encostar; `POST /v1/dev/simulate-touch` só em desenvolvimento. Sem migration.
- **App**: detector com mediana, histerese e referência única de potência (A1: o campo TX declarado pelo emissor é ignorado; o Android anuncia em `high`, sem o campo); um relator só, com orçamento de 40 relatos por minuto; tela nova com os estados 1 a 20 da §11.4, cartão do encosto com "Bloquear" e "Denunciar" (§11.14), `TouchHint` no `packages/ui`, vibração (`expo-haptics` ~58.0.7, aval do `seguranca`), foco e anúncios em fila; tela de calibração só no build de desenvolvimento (`/dev/proximidade`); rotas tipadas sem `as any`.
- **Segurança**: o veto ALTO (potência declarada confiada) foi corrigido pelo A1; os MÉDIOS e BAIXOS das revisões seguintes foram fechados no A2 e no A2 rev. 1, menos o R22 (diferença de tempo de resposta), o R23 (entrega do cartão sem confirmação) e o BAIXO 7 (cartão que chega no fim do minuto), abertos e registrados.
- **Risco residual R21, aceito pelo PO**: um transmissor mais forte que um celular pode parecer "encostado" a metros (estimativa na §16 da arquitetura; a linha "atacante" do spike, MAN-BLE-06, mede).

Pendente:

- **Não compilado nem testado**: o Swift e o Kotlin do módulo. Precisam de um **dev build novo do EAS** (Android e iOS).
- **Spike 4.1-B em aparelhos** (dois iPhones e Androids): calibrar os limiares de `touch-calibration.ts`, MAN-BLE-01 a 06 (inclui a linha "atacante"), MAN-QR-01, MAN-CON-01, foco e anúncios com VoiceOver e TalkBack.
- ~~**CI**: o PROX-56 (Lua no Valkey real).~~ (atualizado em 2026-10-31) Resolvido no CI do PR #3 (`real-services`, sem nenhum teste pulado).
- ~~**Próximo PR**: "denunciar quem você bloqueou" (R1-PO-1, aprovado pelo PO, depende do `dados`) e os achados MÉDIOS e BAIXOS da varredura de segurança.~~ (atualizado em 2026-10-31) Feito na branch `feat/denunciar-bloqueado`: ver a seção seguinte.
- **Política de Privacidade** (`C:\dev\sussurro-site`): os itens da `arquitetura.md` §15 (orientações 1 a 8), com a aprovação do PO antes de publicar.

### Fase 4d: denunciar quem você bloqueou (R1-PO-1) e o Adendo A3 (R22, R23, BAIXO 7): verificado × pendente

Branch `feat/denunciar-bloqueado`, sobre a `main` com o PR #2; mergeada na `main` pelo PR #3 (squash 8ddc3ea, 2026-10-31), com o CI da `main` verde. O `audit`, que só roda na `main` e não bloqueia, falhou como já acontecia no PR #2, pelo `zod` do `@expo/cli` (ver "Registrado para depois"). Desenho: `docs/equipe/adr/0012-conectar-encostando.md` (decisão R1-PO-1, Adendo A3 e A3-8), `docs/equipe/arquitetura.md` §5, §7, §11, §15 e §16 (R22 a R25) e `docs/equipe/ux.md` §11.14 a §11.17. Verificado em 2026-10-31, na máquina do PO (Windows 11, Node 26.13.0, pnpm 12.13.0), **sem Docker e sem aparelho**:

- Reconferência do Tech Lead, sem cache: `pnpm format:check`; `pnpm turbo run lint typecheck --concurrency=1 --force` (15 tarefas); unitários com `--maxWorkers=2`: shared 227, db 13, api 338, worker 73, ui 229, mobile 600; `pnpm build` (4 tarefas); `npx expo-doctor` 20/20.
- E2E no PGlite, direcionado: `proximity-touch`, `proximity` e `proximity-card-actions` (83; o `real-services`, com 15, só roda no CI); `privacy-canary`, `routes`, `blocks`, `reports`, `connections` e `dev-routes` (80).
- **CI do PR #3** (2026-10-31, runs 41208827122 e 41210064114): `quality`, `build`, `infra`, `test` e `secrets` verdes. O `test` roda com Postgres e Valkey reais, sem nenhum teste pulado: 414 e2e da API, entre eles os 15 do `real-services` (PROX-56, 66 e 67, os scripts Lua) e o bloco do `findTouchPair`; mais 3 de integração com serviços reais. O primeiro run falhou só no `secrets` (gitleaks), com um falso positivo: o token fictício `'NuncaEmitidoTok1'` do teste PROX-70, na linha 1513 do `useTouch.test.tsx`. No commit 1d6ec15, o `testes` passou o valor para uma constante, e o `devops` pôs a impressão digital do 8b86e22 no `.gitleaksignore`, como na 475cabf. O `seguranca` aprovou, sem achados, e preferiu esse caminho a reescrever o histórico.
- Mutação (`testes`): 13 de 14 na R1-PO-1 (o sobrevivente é equivalente); 17 de 17 no A3 do servidor (os 4 do Lua só pela conferência do texto; o comportamento é o `real-services`, no CI); todos os do `findTouchPair`, do `touchRevealParties` e do rótulo da reentrega; 38 + 10 + 5 no app.
- **R1-PO-1** (aprovada pelo PO): `POST /v1/reports` aceita a denúncia de **conta** quando quem denuncia bloqueou o alvo, sem prazo e sem consultar o Valkey (`AccessPolicyService.canReportAccount`, `RelationsRepository.hasBlocked`, direcional). O bloqueio (`canBlockOrReport`), post e comentário não mudam. No app, o T46 saiu do formulário aberto pelo Bloqueado, e o Bloqueado não vence mais. Caso PROX-65; X.1 CA1 do `backlog.md` atualizado.
- **A3-1 (R22)**: com token válido de outra conta, o `touches` sempre faz `recordTouch` → `findTouchPair` → `claimTouchPair` (`'refused'` quando a política recusa). O `findTouchPair` (novo, do `dados`) devolve as duas linhas em todos os casos, com 1 forma de plano. A decisão fica em `AccessPolicyService.touchRevealParties`. O `resolve` (QR) continua no `findNearby`. Caso PROX-66.
- **A3-2 (R23)**: o cartão devido é reentregue à mesma pessoa por até 10 s, marcado com `!`, e a reentrega conta no limite de 60/min. Na reentrega, o rótulo é só o token do casamento, sem `findRecent`. Caso PROX-67.
- **A3-3 (app)**: prazo de 4 s no relato (`AbortController`); falha de rede ou 5xx repete o mesmo token por até 10 s; renovação dos tokens com 3 tentativas e teto de 6 emissões em 60 s; reentrega ignorada por @ e por conta, limpa no fim da sessão; o cartão que chega fora do Pronto aparece; o aviso "Não deu para confirmar" passou de 4 s para 7 s. Orçamento medido: 51 relatos por admissão e até 56 em 60 s com rede alternando, abaixo dos 60 do servidor. Caso PROX-68.
- **A3-4 (BAIXO 7)**: estado 21 (cartão atrasado, sem ações e sem prazo) e estado 22 (cartão sem Conectar), com os textos T47 e T48 (**propostos, a aprovar pelo PO**). Casos PROX-69 e PROX-70.
- **A3-5**: `pairExpiresInS` limitado a 55.
- Sem migration, sem dependência nova, sem rota nova (o PERM-10 não muda), sem código de erro novo e sem mudança de contrato (só comentários no `packages/shared`). O `packages/ui` ganhou só a prop opcional `titleRef` no `EmptyState`.
- **Revisões**: `seguranca` em três passadas, sem veto. Os BAIXOS do diff foram corrigidos neste PR: o resíduo do R22 no `findNearby`, o rótulo da reentrega, o texto da Política (duas vezes) e a deduplicação no logout. `ux-ui` aprovou com ressalvas, e as correções C1, C2, S1 e S2 foram feitas. O `dados` conferiu o plano do `findTouchPair` e o do `findNearby`.
- **Ordem de deploy**: a API e o app funcionam em qualquer ordem; recomenda-se a API primeiro.

Pendente:

- **Decisões do PO** (`ux.md` §11.16 e ADR 0012, "Para o PO"): os textos T47 e T48 (A3-PO-2); o "Denunciar" na tela "Contas bloqueadas" (recomendação do `ux-ui`: sim), que também decide qual frase da R1-PO-1 vai à Política; o Bloqueado sem prazo mostrar nome e foto até "Voltar" (recomendação: manter); o texto da Política (A3-PO-1), só depois do deploy. Para ciência: o aviso aos 7 s.
- **Aparelhos**: MAN-QR-01 (cartão que chega no QR; `onDismiss` da câmera no iOS; fechamento no Android), MAN-BLE-03 (Bluetooth desligado com o cartão na tela; rede de verdade e o `AbortSignal` do `fetch` do React Native) e MAN-A11Y-01 (estados 21 e 22, o cartão fora do Pronto e o foco nas saídas, com VoiceOver e TalkBack).
- **Registrado para depois** (fora deste PR):
  - o teto de emissões zera ao sair da aba, e o "Tentar de novo" logo depois da parada pelo teto pode receber 429 (só o motivo da tela muda);
  - S3 do `ux-ui` (foco no T32 no QR; anterior ao PR);
  - exportar o limite de 6 tokens por minuto no `packages/shared`;
  - o 401 repetido com a sessão trocada no meio do voo (BAIXO anterior ao PR, `frontend`);
  - ~~`pnpm audit` no `@expo/cli` (BAIXO anterior ao PR, `devops`);~~ (atualizado em 2026-10-31) Feito no PR #4: há uma exceção registrada para o GHSA-mrhx-c7xc-m3w5, cobrada no `quality` até 2026-11-30, porque o `@expo/cli` 58.1.18 já não usa o `zod`;
  - ~~`CODEOWNERS` para o `.gitleaksignore` e o `.gitleaks.toml`, com a revisão do dono exigida na proteção da `main`, e o passo a passo do falso positivo no `infra.md` §8 (BAIXO anterior ao PR, `devops`).~~ (atualizado em 2026-10-31) Feito no PR #4 (`.github/CODEOWNERS` e `infra.md` §8.1 e §8.2). Para ter efeito, falta o PO decidir pelo GitHub Pro e pela proteção da `main`;
  - os riscos R24 e R25 (`arquitetura.md` §16).

### Fase 5a: verificado × pendente

Back-end, worker e contratos dos reels (histórias 5.1, 5.2, 5.3 no servidor e 5.6 no servidor; D10 e A-21). As telas (5.3 a 5.6 no app) ficam para a Fase 5b. Verificado em 2026-10-30, na máquina do PO (Windows 11, Node 26.13.0, pnpm 12.13.0), **sem Docker, sem AWS e sem aparelho**:

- Rodado em partes por causa da memória: `pnpm format:check`; `pnpm turbo run lint typecheck --concurrency=1` (15 tarefas, lint com 0 avisos); unitários com `--maxWorkers=2` (shared 170, db 13, api 150, worker 60, ui 184, mobile 244); `pnpm build --concurrency=1` verde.
- Dependência nova: `@aws-sdk/client-mediaconvert` 3.1152.0 no worker (a mesma linha dos outros `@aws-sdk/*`; o lockfile passou na política de supply-chain). Nenhum binário externo (ffmpeg/ffprobe): o worker lê os cabeçalhos do MP4/MOV em TypeScript.
- Migration nova do drizzle-kit: `0005_reels` (poster do app em `post_media`: `poster_incoming_key`, `poster_mime` e `poster_size_bytes`; duração obrigatória e positiva no vídeo; poster só no vídeo e completo).
- E2E com `TEST_DB=pglite` e um worker, nos arquivos novos, alterados e de permissão afetados (o `pnpm test:e2e` inteiro não cabe na memória desta máquina):
  - api: `reels` (novo) 18; `privacy-canary` e `routes` 16; `posts`, `feed`, `media` e `profile-posts` 75; `interactions`, `seed-privacy`, `account-deletion`, `dev-routes` e `blocks` 46; `flow`, `me`, `follows` e `reports` 25; `media-real-services` com 4 pulados (S3/SQS reais, das fases anteriores);
  - worker: todos os arquivos, 57, com 3 pulados (DLQ no ElasticMQ e o adaptador S3 no SeaweedFS, inclusive o teste novo de HEAD, leitura por intervalo e cópia); `video` (novo) tem 25 deles;
  - db: todos os arquivos, 51, com 2 pulados (pool do `node-postgres`).
- Contrato (sem rota nova; `packages/shared`):
  - `POST /v1/posts/drafts` aceita `{type:'reel', video:{mime,sizeBytes,durationS}, poster:{mime,sizeBytes}}`: MP4 ou MOV de até 200 MB e 90 s, poster JPEG/PNG/WebP de até 5 MB. 91 s, 90,01 s ou 200 MB + 1 byte → 400. Resposta `Draft` com o vídeo em `uploads[0]` e a URL do poster em `poster` (tipo e tamanho assinados, 10 min). 429 acima de 10 rascunhos de reel por hora (além dos 20 rascunhos/h).
  - `POST /v1/posts/:id/publish`: `HEAD` do vídeo e do poster; o que faltar → 409 `MEDIA_NOT_UPLOADED` com `details.positions` (`[0]` = vídeo) e `details.poster`. Manda `post-video` para a `media-jobs`.
  - `PostMedia` ganhou `kind` (`image`/`video`) e `durationS` (snapshot PERM-11 revisto). No vídeo pronto, `url` é o MP4 e `thumbUrl` o poster; processando ou com falha, nenhuma URL (nem a do poster). Helpers `formatReelDuration` (`0:42`) e `reelVideoLimitViolation` e as constantes `MAX_REEL_DURATION_S`, `MAX_VIDEO_BYTES` e `MAX_POSTER_BYTES`.
- Worker (`VIDEO_PROCESSOR`):
  - `passthrough` (dev): confere o vídeo pelos bytes (`ftyp`, `mvhd`/`mehd`, `tkhd`), sem baixá-lo; copia para `media/{id}/video.mp4` dentro do S3; o poster do app sai sem nenhum metadado (sharp, 720 px); publica na hora. Recusado em produção (copia a localização do vídeo, A-21);
  - `mediaconvert`: recusa, antes de criar o job, o que não é vídeo ou passa de 90,5 s; `CreateJob` com `userMetadata.app = sussurro` e o `mediaId`, `ClientRequestToken`, `Rotate: AUTO`, MP4 H.264/AAC 720×1280 com o `moov` no começo e C2PA excluído, e um quadro JPEG de poster. Consumidor da `video-events`: `COMPLETE` publica (com a duração medida de novo), `ERROR` marca `failed`, repetido não muda nada, evento de outro app ou de job desconhecido é descartado sem efeito;
  - o original e o poster saem de `incoming/` ao terminar; a limpeza (rascunhos, posts apagados, hard delete) apaga também o poster e as saídas do vídeo; um reel apagado com job do MediaConvert rodando espera o evento antes de sair.
- Casos cobertos: 5.1 CA1 e CA2; 5.2 CA2, CA3 e CA4 (o CA1 é o A-21, abaixo); 5.3 CA1 (no servidor), CA2 (o 400) e CA3; 5.6 CA1 (no servidor: só o autor vê, "Excluir" e "Tentar de novo" como rascunho novo); MID-09 e MID-10 para reels (feed, perfil, detalhe, comentários, curtir e URLs); MID-14, exceto o GPS no MediaConvert de verdade; FEED-05 (reel); PERM-10 e 10b com o reel publicado, processando e em rascunho de Y e o reel da conexão canária; PERM-11; A-30 (só reels publicados contam nas publicações); X.3 e o rate limit do R10.
- Demonstrado localmente: tirar a conferência de `ready` antes de assinar a URL derruba 3 testes do `reels`; aceitar o evento sem conferir o id do job derruba o 5.2 CA3; tirar o limite de 90 s no worker derruba 3 testes do `video`. As mudanças foram desfeitas.
- Roteiro manual com a API (`node dist/main.js`) e o worker (`VIDEO_PROCESSOR=passthrough`) de verdade, contra o `pnpm db:pglite` com `pnpm db:migrate` e `pnpm db:seed` (rodado duas vezes: 5 reels na primeira, 0 na segunda). Sem Docker, o S3 e o SQS foram um emulador mínimo em memória escrito só para este roteiro (fora do repositório). 33 passos OK, 41 chamadas à API, nenhum 5xx e nenhum erro no log:
  - rascunho de 91 s e de 200 MB + 1 byte → 400;
  - rascunho de 12,5 s → PUT do vídeo e do poster (com EXIF e GPS) → `publish` → `processing` para @helena e 404 para @caio.r (conexão) e @lucasf; o worker publica, e @caio.r vê o reel na aba Reels do feed e do perfil (1080×1920, 12,5 s), nunca na aba Fotos; @lucasf e @cozinhadabia recebem 404;
  - o vídeo servido é o enviado; o poster servido não tem EXIF nem GPS; o original e o poster saíram de `incoming/`;
  - vídeo de 95 s declarado como 30 s → `failed`: só @helena vê o tile, nada no feed de @caio.r; "Excluir" → 204 e depois 404; HTML disfarçado de MP4 → `failed`;
  - o reel de @cozinhadabia aparece para @caio.r (segue) e não para @lucasf; o reel do seed de @marinac aparece para @helena e dá 404 para @caio.r;
  - `seed:media` gravou 36 objetos (fotos, posters 9:16 e os MP4 de exemplo) e, rodado de novo, nenhum.

Decisões (onde os documentos eram omissos; o mais conservador em privacidade):

- "Tentar de novo" (5.6) **recria** o reel (rascunho novo com o mesmo arquivo, como nas fotos da 2b): o original e o poster são apagados de `incoming/` assim que o processamento termina, com sucesso ou com falha. Nenhuma rota nova de reprocessamento.
- O worker recusa `VIDEO_PROCESSOR=passthrough` com `NODE_ENV=production`.
- A duração é conferida no servidor sem binário: os cabeçalhos do container (`mvhd`, ou `mehd` no MP4 fragmentado) lidos por intervalo de bytes, com folga de 0,5 s sobre os 90 s; com o MediaConvert, também o `durationInMs` do evento. Arquivo sem `ftyp` no começo ou sem duração legível → `failed`.
- Com o MediaConvert, o poster é o quadro gerado pelo job (ADR 0006) e o do app é apagado na hora; o app manda o poster sempre (o passthrough o usa), sem saber o modo.
- O tipo declarado (`video/mp4` ou `video/quicktime`) não precisa bater com o container: os dois são ISO BMFF e os seletores dos aparelhos nem sempre informam o certo. O vídeo copiado pelo passthrough sai com o tipo medido.
- 10 rascunhos de reel por hora por conta (R10), além dos 20 rascunhos/h.
- `durationS` só aparece na resposta com o vídeo pronto (a duração medida), como a largura e a altura.

Pendente:

- **A-21 / MID-14 (5.2 CA1)**: a remoção da localização pelo MediaConvert só é verificável depois do `apply` (Fase 7). Roteiro pronto, não executado: [`testes.md` §8.2](docs/equipe/testes.md). A confirmar no mesmo roteiro: vídeo sem áudio (o seletor de áudio padrão) e o primeiro quadro como poster.
- ~~**Com Docker** (WSL2 ainda não instalado): `pnpm test:e2e` no modo padrão, com o teste novo do adaptador S3 do worker (HEAD, leitura por intervalo e `CopyObject` no SeaweedFS) e os pulados das fases anteriores.~~ (atualizado em 2026-10-31) Resolvido pelo CI, sem nenhum teste pulado.
- ~~**CI remoto** (nada enviado ao GitHub).~~ (atualizado em 2026-10-31) Resolvido: o CI roda desde o PR #1 e está verde na `main`.
- **Fase 5b**: modo REEL no Criar (seletor de vídeo, "Até 90 s", poster com `expo-video-thumbnails`, faixa "Processando o reel…"), `ReelTile` com a duração na aba Reels do feed e do perfil, `ReelViewer` com `expo-video` (sem avançar sozinho), o tile "Falhou" com "Tentar de novo"/"Excluir", MAN-REEL-01 em aparelho e um dev build novo.
- **Risco aceito**: um `COMPLETE` que chegue depois de o reel com falha por tempo esgotado (60 min) já ter sido apagado de vez deixa as saídas órfãs em `media/{id}/` (nunca servidas). Só acontece se o MediaConvert passar de uma hora.
- **Política de Privacidade** (`C:\dev\sussurro-site`): vídeo e poster dos reels, metadados e processamento pela AWS, conforme o relatório da Fase 5a.

### Fase 5b: verificado × pendente

Telas dos reels (histórias 5.3 a 5.6 no app; D10, D-UX7 e D-UX14). Verificado em 2026-10-30, na máquina do PO (Windows 11, Node 26.13.0, pnpm 12.13.0), **sem Docker, sem Mac, sem JDK/Android SDK e sem aparelho**. O back-end (`apps/api`, `apps/worker`, `packages/db`) e o `packages/shared` não mudaram.

- Rodado em partes por causa da memória: `pnpm format:check`; `pnpm turbo run lint typecheck --concurrency=1` (15 tarefas, lint com 0 avisos); unitários com `--maxWorkers=2` (shared 170, db 13, api 150, worker 60, ui 211, mobile 294); `pnpm build --concurrency=1` verde. `expo-doctor` 20/20. `expo export --platform android` gera o bundle Hermes (`.hbc`).
- Dependências novas, com `npx expo install` (versões do SDK 58; o lockfile passou na política de supply-chain): `expo-video` 58.0.13 (no app e, como peer e dev, no `packages/ui`, só para o `ReelViewer`) e `expo-video-thumbnails` 58.0.2 (no app). Nenhuma outra.
- Permissões, conferidas com `expo config --type introspect` e `expo prebuild --no-install --clean --platform android` (a pasta gerada foi apagada): **nenhuma permissão nova**.
  - Android: o `AndroidManifest.xml` principal tem a mesma lista da 4b. O plugin do `expo-video` entra com `supportsBackgroundPlayback: false` e `supportsPictureInPicture: false` (sem `FOREGROUND_SERVICE*`, sem serviço de mídia e sem picture-in-picture na atividade principal). O manifesto da própria biblioteca só declara `INTERNET` (já existia) e a atividade de tela cheia dela, que o app não abre (`fullscreenOptions.enable: false`). O `expo-video-thumbnails` não declara nada.
  - iOS: sem `NSMicrophoneUsageDescription`; `UIBackgroundModes` fica vazio (o plugin tira o `audio`). O `NSPhotoLibraryUsageDescription` passou a dizer "as fotos e os vídeos que você escolher" (o seletor do sistema não pede essa permissão; a chave existe porque o módulo a referencia).
- Telas:
  - **Criar → REEL** (5.3): a pílula REEL habilitada (e `/criar?modo=reel`, aberto pelo "Nova publicação" da aba Reels vazia do perfil). O vídeo vem do seletor do sistema, um por vez, só vídeos, sem acesso à galeria e sem conversão no aparelho (o `.mov` HEVC do iPhone vai como está). A grade de 4 colunas mostra a capa e a duração; vídeo acima de 90 s fica esmaecido com "Até 90 s", acima de 200 MB com "Até 200 MB" e de outro tipo com "MP4 ou MOV" (`reelVideoLimitViolation`), e não pode ser marcado (Toast com o motivo). A capa é o primeiro quadro (`expo-video-thumbnails`), regravada em JPEG de até 1280 px pelo `expo-image-manipulator` (sem metadados); a prévia 9:16 abre o vídeo local no `ReelViewer`. Legenda opcional. O rascunho leva o tipo, o tamanho exato e a duração do seletor e o tipo e o tamanho da capa.
  - **Faixa de publicação**: PUT do vídeo direto do arquivo (barra com a fração enviada) e PUT da capa, com exatamente os cabeçalhos devolvidos; `publish`; "Processando o reel…" com consulta ao `GET /v1/posts/:id` (até 10 s entre uma vez e outra) até `published` (Toast "Publicado.") ou `failed`. Enquanto processa, o tile "Processando" aparece na aba Reels do próprio perfil. 409 `MEDIA_NOT_UPLOADED`: o "Tentar de novo" reenvia só o que falta (`positions: [0]` = o vídeo; `poster: true` = a capa), no mesmo rascunho. Falha de rede: o "Tentar de novo" retoma no mesmo rascunho (ou num novo, se a URL venceu). Offline, 429 e e-mail não confirmado como no FOTO.
  - **Grade de reels** (5.4, p08): `ReelTile` 9:16 em 3 colunas, com "▶ 0:42" (`formatReelDuration`) sobre o `mediaScrim`, na aba Reels do feed (com "Você está em dia") e do perfil; rótulo "Reel de @marinac, 42 segundos".
  - **Visualizador** (5.5, rota `reel/[id]`, `fullScreenModal` preto): só o reel aberto toca, com som, sem loop, sem segundo plano, sem notificação de mídia, sem AirPlay e sem PiP; o toque pausa e retoma; no fim para no último quadro, escurece e mostra "Assistir de novo"; **nunca abre outro reel** (o componente só conhece um). Pausa com os comentários por cima e continua ao voltar. Com VoiceOver/TalkBack há o botão "Pausar/Reproduzir" no topo e nenhum controle some. Curtir (o criador só vê o número, A-06), comentar (a folha de comentários de sempre), som, autor (abre o perfil na aba de origem), legenda com "mais", barra de progresso, arrastar para baixo ou ✕ para fechar. Erro de reprodução: "Não foi possível reproduzir este reel." com "Tentar de novo" (busca o post de novo, para uma URL assinada nova).
  - **Falha** (5.6): no próprio perfil, o tile "Falhou" abre "Tentar de novo" e "Excluir". "Tentar de novo" recria o reel: com o vídeo desta sessão, gera a capa de novo (o que também confere se o arquivo ainda está no aparelho), apaga o reel que falhou e cria um rascunho novo com o mesmo arquivo; reel de outra sessão ou arquivo que sumiu ("O vídeo não está mais no aparelho."): "Escolher o vídeo de novo" ou descartar (✕, que apaga o reel que falhou).
  - **Menus** (3b): o ⋯ do visualizador tem "Excluir publicação" no próprio reel e "Denunciar"/"Bloquear" nos de outras contas; bloquear fecha o visualizador e os reels da conta somem das grades.
  - **Nada que não esteja publicado fora do perfil do autor**: além do servidor, o app filtra o feed e o perfil de outra conta (só `published`) e o visualizador recusa um reel não publicado de outra conta ("Esta publicação não está mais disponível.").
- Componentes novos no `packages/ui` (e no catálogo, seção "Reels" e "Feed Reels (p08)" em "Telas compostas"): `ReelTile`, `ReelViewer` e `MediaScrim`; o `UploadBanner` ganhou o reel ("Processando o reel…", fração enviada e "O vídeo não está mais no aparelho."); ícones `pause` e `video`; `spokenDuration`; `useScreenReaderEnabled`.
- Casos cobertos no app: 5.3 CA1 (no app), CA2 (a grade do Criar) e CA3; 5.4 CA1; 5.5 CA1 e CA2; 5.6 CA1; MID-08, MID-09 e MID-10 para reels; MID-14 no app (limites de 90 s e 200 MB, 90,01 s, `.mov`); FEED-05 (reel) no app; X.1, X.2, X.3, A-06 e 2.2 CA9 nos reels.

Decisões (onde os documentos eram omissos; o mais conservador em privacidade):

- **Upload do vídeo sem dependência nova**: `XMLHttpRequest` com `{ uri }` no corpo (o módulo de rede do React Native lê o arquivo do disco; no Android, em streaming). O `fetch` + `blob()` das fotos carregaria até 200 MB na memória (no Android, no heap Java). No iOS o módulo de rede ainda carrega o arquivo na memória. **Para o PO (recomendado)**: declarar o `expo-file-system` (já vem com o `expo`, não muda o binário) e usar o `uploadAsync` com sessão em segundo plano no iOS, se o MAN-REEL-01 mostrar falta de memória ou o envio parar ao sair do app.
- Nada do reel é guardado no aparelho entre sessões (o caminho do vídeo fica só em memória); por isso o "Tentar de novo" de outra sessão pede o vídeo de novo, com a mesma legenda. O reel que falhou só é apagado depois de a capa do vídeo novo ser gerada.
- Vídeo sem duração ou tamanho informados pelo seletor é recusado ("Não abre"), em vez de medir o arquivo inteiro na memória.
- Vídeo deitado é aceito (a API não recusa); o visualizador o mostra inteiro (`contain`), sem cortar.
- O botão "Pausar/Reproduzir" aparece só com leitor de tela (5.5 CA2); sem ele, o toque no vídeo pausa e o ▶ fica no centro enquanto estiver pausado.
- Textos sem documento: "O vídeo não está mais no aparelho.", "Escolher o vídeo de novo", "Não foi possível publicar este reel.", "Compartilhe seu primeiro reel", "Nenhum reel ainda.", "Escolha um vídeo de até 90 s abaixo", "O reel pode ter até 90 segundos.", "O vídeo pode ter até 200 MB.", "Use um vídeo MP4 ou MOV.", "Não foi possível ler este vídeo. Escolha outro.", "Não foi possível gerar a capa deste vídeo. Escolha outro." e "O reel terminou." (leitor de tela).

Divergências do protótipo e dos documentos:

- Grade do Criar (ux.md §4.5): os vídeos vêm do seletor do sistema, um por vez, e não da galeria inteira (sem pedir acesso, como as fotos da 2b); um vídeo longo só aparece esmaecido depois de escolhido. O tile por tamanho diz "Até 200 MB" (o ux.md só prevê "Até 90 s").
- **Som no modo silencioso do iPhone**: o ux.md §6.14 pede respeitar, mas o `expo-video` usa a categoria de áudio `.playback`, que toca com som mesmo com a chave do silencioso ligada. Sem API para isso no `expo-video`; o botão de som fica no topo. Decisão do PO: aceitar na v1 ou começar mudo.
- O ⋯ do visualizador (coluna da direita, abaixo de comentar) não está no wireframe 4.4; entra pelo D-UX14 (menu em toda publicação).
- O ▶ fica no centro enquanto o vídeo está pausado, em vez de aparecer só 600 ms.
- A prévia do Criar abre o vídeo em tela cheia (o mesmo `ReelViewer`, sem curtir nem comentar), em vez de tocar dentro da prévia.
- O `ReelTile` recebe a duração já formatada (`duration`), e não `durationS`: o `packages/ui` não depende do `packages/shared`, e o app usa o `formatReelDuration`.
- A rota do visualizador leva a aba de origem (`reel/[id]?origem=/pessoal/inicio`), como a folha de comentários, em vez de `origem=feed|perfil:@handle` (ux.md §3.2).

Pendente:

- **Dev build EAS novo** (Android e iOS, conta Apple, A-02): entraram o `expo-video` e o `expo-video-thumbnails`, módulos nativos que os builds anteriores não têm.
- **Aparelhos**: MAN-REEL-01 (reel de 90 s e de 91 s; `.mov` HEVC do iPhone; não avança sozinho no fim) e, no mesmo roteiro: envio de um vídeo perto de 200 MB no Android (streaming) e no iPhone (memória); sair do app durante o envio; a capa de vídeo gravado em pé no Android (rotação do primeiro quadro); som com o iPhone no silencioso; VoiceOver e TalkBack no visualizador (botão "Pausar", ordem do foco, controles fixos); arrastar para baixo para fechar; a folha de comentários por cima do visualizador (iOS) e o modal (Android).
- **A-21 / MID-14** (GPS no vídeo): continua só verificável com o MediaConvert de verdade, depois do `apply` (roteiro em [`testes.md` §8.2](docs/equipe/testes.md)). Em dev, o passthrough serve o vídeo com os metadados do original: só vídeos de teste sem localização.
- ~~**Com Docker** e **CI remoto**: os mesmos pendentes da 5a.~~ (atualizado em 2026-10-31) Resolvidos pelo CI.
- **Fora desta fase**: o tile "Processando" de um reel enviado em outra sessão só muda ao puxar para atualizar (sem consulta automática); abrir um reel pelo detalhe `p/[id]` (notificações, Fase 6) deve levar ao visualizador (feito na 6b, em `PostDetailScreen.tsx`).
- **Política de Privacidade** (`C:\dev\sussurro-site`): seleção de vídeos e o que sai do aparelho nos reels, conforme o relatório da 5b.

### Fase 6a: verificado × pendente

Back-end, worker e contratos das notificações, do push e da observabilidade (histórias 6.1, 6.2, 6.3, 6.4 e 6.6 no servidor, 6.5, 6.7 no servidor e 6.8; ADR 0011, D4). As telas, o `expo-notifications`, o pedido de permissão e o Sentry do app ficam para a Fase 6b. Verificado em 2026-10-30, na máquina do PO (Windows 11, Node 26.13.0, pnpm 12.13.0), **sem Docker, sem conta Expo, sem conta Sentry e sem aparelho**:

- Rodado em partes por causa da memória: `pnpm format:check`; `pnpm turbo run lint typecheck --concurrency=1` (15 tarefas, lint com 0 avisos); unitários com `--maxWorkers=2` (shared 189, db 13, api 157, worker 67, ui 211, mobile 294); `pnpm build --concurrency=1` verde.
- Dependências novas, com versão exata (o lockfile passou na política de supply-chain): `expo-server-sdk` 8.0.0 no worker (previsto no ADR 0011 e na stack do PO; ESM, usa o `fetch` do Node; traz só `promise-limit` 2.7.0 e `promise-retry` 2.0.1, com `err-code` 2.0.3 e `retry` 0.12.0) e `@opentelemetry/api` 1.10.0 na API e no worker (já estava no lockfile, pelo Sentry; infra.md §5). Nenhuma outra.
- Migration nova do drizzle-kit: `0006_notifications_push` (tabelas `notifications`, `push_tokens` e `push_tickets`; enum `notification_type`; o `CHECK` de anonimato dos seguidores; o upsert do dia e a curtida única por índices únicos parciais).
- E2E com `TEST_DB=pglite` e um worker, nos arquivos novos, alterados e de permissão afetados (o `pnpm test:e2e` inteiro não cabe na memória desta máquina):
  - api: `notifications` (novo) 21 e `push-tokens` (novo) 10; `privacy-canary` e `routes` 17; `interactions`, `follows`, `connections`, `blocks`, `account-deletion`, `auth`, `dev-routes`, `seed-privacy`, `email-flows` e `proximity` 137; `flow`, `me`, `own-lists`, `reports`, `health` e `real-services` 23, com 7 pulados (os das fases anteriores: Valkey, pool do Postgres e `/health/ready` reais);
  - worker: todos os arquivos, 70, com 3 pulados (DLQ no ElasticMQ e o adaptador S3 no SeaweedFS, das fases anteriores); `push` (novo) tem 13 deles;
  - db: todos os arquivos, 57, com 2 pulados (pool do `node-postgres`); `notifications-schema` (novo) 5 e o seed com as notificações.
- Rotas novas, para os dois tipos de conta (nenhuma entra no PERM-05), com o contrato em `packages/shared` (`notifications.ts`) e na `arquitetura.md` §13:
  - `GET /v1/notifications?cursor=&limit=`, `GET /v1/notifications/unread-count` e `POST /v1/notifications/read {upTo}`;
  - `PUT /v1/me/push-tokens {expoToken, platform}` e `DELETE /v1/me/push-tokens {expoToken}` (o token no corpo, nunca na URL).
- Notificações (6.1 a 6.3): gravadas na mesma transação da curtida, do comentário, da resposta, da conexão (pelo aceite ou pelos pedidos cruzados) e do follow, com o push entregue à fila `push` depois do commit (a fila fora do ar não desfaz nada: só o log). Seguidores: uma linha por dia de America/Sao_Paulo (`nf:YYYY-MM-DD`), `count + 1`, volta a ficar não lida e nunca guarda nem devolve quem seguiu (banco, schema da resposta e push). Leitura dos últimos 30 dias, sem o que o leitor não pode mais ver (conta ou post apagado, comentário apagado, bloqueio nos dois sentidos, post de quem deixou de ser conexão, "conectados" de conexão desfeita). Bloquear, desfazer a conexão e excluir a conta apagam as notificações correspondentes na mesma transação.
- Push (6.5, 6.6): a fila leva só ids; o worker relê o banco (lida, bloqueio, conta ou post apagado e sessão encerrada não recebem), monta o texto curto do `packages/shared` (`pushBody`: "lucasf comentou na sua foto.", sem campo para o comentário) e manda a rodada inteira ao Expo num lote (o SDK divide em 100). Tickets guardados em `push_tickets`; recibos a cada 15 min; `DeviceNotRegistered` desativa o token (no ticket ou no recibo); Expo fora do ar → 3 tentativas e DLQ. Seguidores: um push quando a linha do dia nasce ou volta a ficar não lida, com a mesma chave de agrupamento. Pedido de conexão: push para quem recebeu, que abre o Conectar, com validade até o fim dos 120 s. Conexão criada: push só para quem não fez a última ação.
- Push tokens (6.4): ligados à sessão do aparelho (a família de refresh); o logout daquela sessão apaga o token (AUTH-12); sair de todos, troca de senha, refresh reusado e exclusão de conta apagam todos os da conta ou da família; token ativo de outra conta não muda (6.4 CA3); token de sessão encerrada passa para quem registra; até 10 por conta. O worker só envia para tokens de sessões vivas.
- Sentry (6.7, servidor): release, ambiente e amostragem por env; `beforeSend` e `beforeSendSpan` com a limpeza do `packages/shared` (`scrubTelemetryEvent`); o 503 `PROXIMITY_UNAVAILABLE` fica fora do Sentry e vai ao log como `warn` com o código (a pendência da 4a); o worker manda ao Sentry as falhas das filas, da manutenção e dos recibos. Sem DSN, nada é inicializado.
- OpenTelemetry (6.8): `Tracing` na API e no worker (interceptor HTTP, fila `push` com o `traceparent` nos atributos, consumidor e envio ao Expo); com `OTEL_ENABLED=false` nada é chamado no `@opentelemetry/api`. O `traceId` (o do `traceparent` recebido, o do span ativo ou um novo) vai em toda linha de log da requisição.
- Retenção (worker): notificações com mais de 90 dias sem atualização, push tokens desativados há 30 dias ou de sessões encerradas e tickets com mais de 24 h.
- Seed: 18 notificações coerentes com as personas na primeira vez e 0 na segunda (ver "Banco: migrations e seed").
- Casos cobertos: NOT-01 a NOT-09 (o NOT-03 com o relógio de teste às 23:59 e 00:01 de Brasília; o NOT-08 no worker, com o fake do Expo), PROX-29, AUTH-12 com o push token, PERM-17 (Sentry com transporte falso: o envelope enviado pelo SDK não tem `Authorization`, cookies, senha, `token`, `observedToken`, `targetToken`, push token, ids de relacionamento nem listas), PERM-10 e 10b com as rotas novas e o canário de seguidores `canary_follower_*` (NOT-02), PERM-11 (snapshot das respostas novas), PERM-09 e PERM-18 com as rotas novas; 6.1 CA1 a CA3, 6.2 CA1 (servidor), 6.3 CA1 a CA6, 6.4 CA1 a CA3 (servidor), 6.5 CA1 a CA4, 6.6 CA1 (servidor), 6.7 CA1, CA2 e CA4 (servidor) e 6.8 CA1.
- Demonstrado localmente (script de mutação fora do repositório; cada arquivo restaurado e conferido por SHA-256): tirar o `CHECK` de anonimato dos seguidores derruba o NOT-02 do schema; aceitar o ator no schema público derruba o PERM-11; pôr o comentário no texto do push derruba o NOT-08 do worker; o `beforeSend` sem limpeza derruba o PERM-17; tirar `token` das chaves sensíveis derruba a limpeza; o PUT passar o token ativo de outra conta, o DELETE apagar o de outra conta e o logout esquecer o token derrubam o `push-tokens` (8 de 8).
- Roteiro manual com a API (`node --import ./dist/instrument.js dist/main.js`) e o worker (`PUSH_SENDER=log`) de verdade, contra o `pnpm db:pglite` com `pnpm db:migrate` e `pnpm db:seed` (duas vezes: 18 notificações e depois 0). Sem Docker, o SQS e o Sentry foram um emulador mínimo em memória escrito só para este roteiro (fora do repositório; o Sentry com `SENTRY_TRACES_SAMPLE_RATE=1` mandou os spans para ele). 33 passos OK, 41 chamadas à API, nenhum 5xx e nenhum erro no log:
  - helena vê as 6 notificações do seed e o contador 6; cozinhadabia vê "2 novas pessoas…" sem nada de quem seguiu;
  - push tokens de helena, cozinhadabia e caio.r; caio.r tentando registrar o token de helena: 204 e o token continua de helena; formato inválido → 400;
  - caio.r curte e descurte três vezes e curte de novo (1 notificação), comenta um texto longo (o trecho com "…") e helena responde; o log do worker mostra "caio.r curtiu seu texto.", "caio.r comentou no seu texto." e "helena respondeu seu comentário.", com o token mascarado e sem a íntegra;
  - cozinhadabia marca como lidas; estudante a segue; a linha volta a ficar não lida com 3 e o push "3 novas pessoas começaram a seguir você." abre `/criador/notificacoes`;
  - lucasf pede conexão para marinac (simulação de dev): push "lucasf quer se conectar com você." para `/pessoal/conectar`; marinac aceita com o token observado; "conectados" para os dois e push só para lucasf;
  - o logout de helena apaga o token dela; uma curtida depois disso aparece no app e não gera push;
  - a fila `push` só teve ids; os envelopes do Sentry não tinham push token, `Bearer`, JWT, senha nem cursor; o `traceId` do `traceparent` enviado aparece em todas as linhas de acesso.

Decisões (onde os documentos eram omissos; o mais conservador em privacidade):

- `DELETE /me/push-tokens` leva o token no corpo, e não em `/me/push-tokens/:token` (arquitetura.md §13): assim ele não aparece em log de acesso, em proxy nem no Sentry.
- Logout apaga o push token daquela sessão (em vez de só limpar a coluna); sair de todos, troca de senha, refresh reusado e exclusão apagam todos. `refresh_family_id` ficou obrigatório, e o worker só envia para sessões vivas. `PUT` com o token ativo de outra conta não muda nada (mesma resposta, sem revelar a dona); com a sessão dela encerrada, o token passa para quem registra. Até 10 tokens por conta e 30 registros/h.
- O trecho do comentário é lido do comentário na hora (não copiado no `payload`, que fica vazio na v1): apagou o comentário, o trecho some. Até 80 caracteres, numa linha.
- Resposta num post de outra pessoa avisa o autor do comentário (`comment_replied`) e também o autor do post (`post_commented`), sem avisar ninguém duas vezes. Descurtir não apaga a notificação da curtida.
- "Vocês estão conectados" para os dois (PROX-29), mas o push só para quem não fez a última ação; pedido de conexão não vira notificação, só push, com `ttl` até vencer. Desfazer a conexão apaga o "conectados" dos dois.
- Notificações cujo post o leitor deixou de ver (resposta num post de quem deixou de ser conexão) e "conectados" de conexão desfeita somem; o bloqueio esconde e apaga as notificações entre os dois.
- Push de seguidores só quando a linha do dia nasce ou volta a ficar não lida (um push por follow seria barulho); notificação já lida não gera push; o `data` do push leva só o tipo e a rota do app (sem ids nem texto), e a rota é a lista de Notificações (a 6b pode abrir o post a partir dela).
- `GET /notifications` aceita só `cursor` e `limit` (como as listas próprias); `unread-count` para em 99; `POST /notifications/read` devolve o que continua não lido, e `upTo` no futuro vale como agora.
- Seção "Anteriores" no `groupNotifications` para o que tem de 7 a 30 dias (o protótipo só mostra "Hoje" e "Esta semana"); "Esta semana" = de 1 a 6 dias antes, pelo fuso do aparelho (A-35).
- Texto unificado "lucasf comentou na sua foto: “…”" (o p09 mostra "lucasf comentou: “…”" e o p21 "comentou no seu reel:"); push sem título (o sistema mostra o nome do app).
- `PUSH_SENDER=log` em dev (como o `EMAIL_SENDER=log`), recusado em produção; o log mostra o texto e o token mascarado.
- Retenção: push token desativado fica 30 dias; tickets, 24 h.

Divergências dos documentos:

- **Sentry 11** (o instalado desde a Fase 0) removeu o `sendDefaultPii`: o equivalente no servidor é o `dataCollection` (sem usuário, cookies, corpos, query string, cabeçalhos de credencial, banco e fila) mais o `beforeSend`, que tira o `user`. A 6.7 CA4 fala em `sendDefaultPii: false`: no app (6b) ele continua existindo no SDK do React Native. O `beforeSendTransaction` foi trocado pelo `beforeSendSpan`, porque o SDK 11 envia os spans em streaming.
- O "push de seguidores" usa a chave de agrupamento do Expo (`collapseId`/`tag`) com o id da linha do dia; o ADR não previa.
- `arquitetura.md` §6 dizia `refresh_family_id uuid NULL` e "apagado no logout": ficou `NOT NULL` e a linha inteira é apagada (atualizado na Fase 6).

Pendente:

- **Fase 6b**: tela de Notificações (p09 e p21) com "Hoje"/"Esta semana", ponto azul do coração, `expo-notifications` com o pedido contextual (6.4 CA1 e CA4), registro do token a cada abertura e o `DELETE` antes do logout, toque no push abrindo a rota do `data.url` (6.5 CA5, 6.6), Sentry do app (source maps no EAS, release e ambiente, a mesma limpeza) e um dev build novo.
- **Contas**: projeto no Expo com push (credenciais APNs pelo EAS para iOS e FCM para Android; `EXPO_ACCESS_TOKEN` se a segurança reforçada for ligada) e os três projetos do Sentry (`SENTRY_DSN`, `SENTRY_AUTH_TOKEN` para os source maps). Nenhum valor real entrou no repositório.
- **Aparelhos**: MAN-PUSH-01 (permissão, push com o app fechado no iPhone e no Android, tocar e abrir a tela certa, logout para de receber) e o push do pedido de conexão abrindo o Conectar.
- ~~**Com Docker** (WSL2 ainda não instalado): `pnpm test:e2e` no modo padrão, inclusive a fila `push` e a `push-dlq` no ElasticMQ (o `infra/local/elasticmq.conf` já tem as duas) e o upsert de seguidores concorrente em conexões diferentes do pool.~~ (atualizado em 2026-10-31) Resolvido pelo CI. O modo padrão roda desde o PR #1, e a fila `push`, a `push-dlq` e o upsert concorrente ganharam os testes NOT-10 a NOT-12 no PR #4 (run 41234942342, sem nenhum teste pulado).
- ~~**CI remoto** (nada enviado ao GitHub) e o **gitleaks**, que não está instalado nesta máquina.~~ (atualizado em 2026-10-31) Resolvidos: o CI roda desde o PR #1, e o job `secrets` passa o gitleaks em todo o histórico (barrou um falso positivo no PR #3). Os testes usam só valores fictícios de token, DSN e JWT.
- **Política de Privacidade** (`C:\dev\sussurro-site`): notificações guardadas e por quanto tempo, push tokens, o que vai ao Expo, à Apple e ao Google, e o que vai ao Sentry, conforme o relatório da Fase 6a.

### Fase 6b: verificado × pendente

App das notificações, do push e do Sentry (histórias 6.1 a 6.4 no app, 6.5 CA5, 6.6 e 6.7 no app; p09, p21, D-UX19 e a pendência da 5b do `p/[id]` de reel). Verificado em 2026-10-30, na máquina do PO (Windows 11, Node 26.13.0, pnpm 12.13.0), **sem Docker, sem conta Expo, Apple, Google/Firebase ou Sentry, sem JDK/Android SDK, sem Mac e sem aparelho**. O back-end (`apps/api`, `apps/worker`, `packages/db`) e o `packages/shared` não mudaram: o app usa os helpers do contrato (`notificationTextParts`, `notificationPlainText`, `followersBadge`, `groupNotifications`, `PushDataSchema`, `pushTargetUrl`, `ExpoPushTokenSchema` e `scrubTelemetryEvent`).

- Rodado em partes por causa da memória: `pnpm install --frozen-lockfile`; `pnpm format:check`; `pnpm turbo run lint typecheck --concurrency=1 --force` (15 tarefas, lint com 0 avisos); unitários com `--maxWorkers=2` (shared 189, db 13, api 157, worker 67, ui 221, mobile 357); `pnpm build --concurrency=1 --force` verde; `expo-doctor` 20/20. `expo export --platform android --no-bytecode` (só para conferir) gera o bundle com o Debug ID do Sentry (`sentry-dbid-…`), que liga o bundle aos source maps.
- Dependência nova, com `npx expo install` (versão do SDK 58; o lockfile passou na política de supply-chain): `expo-notifications` 58.1.7 no app. Ela traz `expo-application` 58.1.2 (módulo nativo: o id do app e o ambiente do APNs para pedir o token), `badgin` 1.2.3, `abort-controller` 3.0.0 e `event-target-shim` 5.0.1. **Sem `expo-device`**: ele só serviria para não pedir o token num simulador, e o app já trata a falha do `getExpoPushTokenAsync` (o dev build roda em aparelho). O `@sentry/react-native` 8.28.0 já estava; entraram o plugin `@sentry/react-native/expo` e o `getSentryExpoConfig` no Metro, sem pacote novo.
- Permissões e entitlements, conferidos com `expo config --type introspect` nas variantes development e production (sem `prebuild`):
  - **iOS**: entitlement `aps-environment` (`development` na variante development; `production` em preview e produção; o export do EAS ajusta ao perfil de distribuição). Nenhuma chave nova no `Info.plist` (a permissão de notificações não tem texto de uso); `UIBackgroundModes` continua vazio (sem `remote-notification`, sem push silencioso). O pedido do sistema é só de alerta e som, sem o número no ícone.
  - **Android**: `POST_NOTIFICATIONS` (pedida em tempo de execução no Android 13+) vem do manifesto da biblioteca, e o Firebase Messaging (FCM, dentro do `expo-notifications`) acrescenta as dele (`com.google.android.c2dm.permission.RECEIVE` e `WAKE_LOCK`): o merge só acontece no Gradle, então a lista final fica para conferir no APK do EAS. O `RECEIVE_BOOT_COMPLETED`, que a biblioteca usa para reagendar notificações locais, sai com `tools:node="remove"` (o app não agenda nada; o push remoto chega pelo FCM sem ele). Metadados novos: ícone `notification_icon` (o monocromático do ícone adaptativo), cor `#0066FF` e o canal padrão `default` ("Notificações", criado antes do pedido: sem canal o Android 13+ não pergunta).
- **Notificações** (6.1, 6.3; p09 e p21): a da pessoa em `pessoal/inicio/notificacoes` (empilhada no Início, com a tab bar e o Início ativo, D-UX19) e a do criador na aba (`criador/notificacoes/`, agora uma pilha com `p/[id]` e `u/[handle]`). "Hoje", "Esta semana" e "Anteriores" pelo fuso do aparelho (A-35); skeleton, vazio ("Nada por aqui ainda." / "Quando alguém curtir ou comentar, aparece aqui."), erro com "Tentar de novo", "Não carregou. Tentar de novo" na página seguinte, fim ("Isso é tudo por enquanto."), paginação por cursor e puxar para atualizar. A linha de seguidores tem o avatar "+N" em `blueLight` ("99+" acima de 99), o texto no singular e no plural e nenhum toque. Com `profileVisible` falso, o @ fica em 600 sem toque (e sem a ação de perfil do leitor de tela); com verdadeiro, abre o perfil na aba da tela. Tocar abre o post (`p/[id]` na aba) ou, se for reel, o visualizador; "conectados" abre o perfil.
- **Ponto azul** (6.2): `GET /notifications/unread-count` ao abrir com sessão, ao voltar ao app e ao receber um push com o app aberto. No Início o coração ganha o ponto e o rótulo "Notificações, há novidades"; no criador, a aba Notificações. Ao abrir a lista, `POST /notifications/read {upTo}` com o `updatedAt` da primeira notificação: o ponto some na hora e fica com o que o servidor devolve; se falhar, volta ao valor do servidor (sem repetir sozinho; puxar para atualizar tenta de novo). As não lidas mantêm o ponto na linha enquanto a lista está aberta. Push recebido com a lista aberta: ela recarrega.
- **Push no app** (6.4, 6.5 CA5, 6.6):
  - Pedido contextual depois do primeiro post publicado ou da primeira conexão (Alert "Quer saber quando alguém curtir ou comentar?" [Agora não] [Ativar]), **uma vez por conta neste aparelho**: "Agora não", a recusa no diálogo do sistema e a permissão já negada de vez não geram outro pedido (6.4 CA4). "Ativar" pede a permissão do sistema e registra o token.
  - O token (`PUT /me/push-tokens {expoToken, platform}`, no corpo) é registrado a cada abertura com sessão, só se a pessoa ativou neste aparelho e o sistema permite. A escolha e o último token ficam no Keychain/Keystore, por conta.
  - **Conta → "Notificações neste celular"**: ligar pede a permissão (negada de vez: "Abrir Ajustes"); desligar chama o `DELETE /me/push-tokens {expoToken}`. Sem rede, o erro aparece e continua ligado.
  - **Logout**: o app não chama o `DELETE`, porque o `POST /auth/logout` já apaga o token da sessão no servidor (AUTH-12); entrar de novo, com a escolha ligada, registra outra vez. Sair de todos, exclusão de conta e sessão expirada também ficam com o servidor.
  - Toque no push com o app aberto, em segundo plano ou fechado: o `data` passa pelo `PushDataSchema` e só a rota que o servidor monta para aquele tipo e aquele tipo de conta (`pushTargetUrl`) é aceita; qualquer outra coisa só abre o app. Com o app fechado, o destino espera a sessão e a aba inicial; sem sessão, só abre o Entrar. O pedido de conexão abre o Conectar (o aceite continua exigindo a tela aberta e o token cruzado).
  - Com o app aberto, o push aparece como banner, sem som e sem número no ícone.
- **Sentry do app** (6.7, PERM-17): só com `EXPO_PUBLIC_SENTRY_DSN` (D4). `sendDefaultPii: false` e nenhum `setUser`; sem sessões de release health, captura de tela nem hierarquia de views. `beforeSend`, `beforeSendTransaction` e `beforeBreadcrumb` passam pelo `scrubTelemetryEvent` e, além dele, tiram o @, os ids e a query das URLs e rotas (`/v1/creators/:handle/follow`, `/pessoal/inicio/u/:handle`, `/c/:token`) e descartam os breadcrumbs de toque. O `sentry-trace` só vai para a API (nunca para o S3 ou o Expo). Ambiente = variante; release e `dist` do próprio SDK (`app.sussurro.dev@0.0.0+N`), os mesmos do upload; amostragem do tracing por `EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` (vazia = 0). Source maps: o plugin do Expo faz o upload no EAS Build quando há `SENTRY_AUTH_TOKEN` (secret do EAS), `SENTRY_ORG` e `SENTRY_PROJECT`; sem os três, o upload fica desligado e o build não falha. O catálogo de desenvolvimento tem "Enviar erro de teste" (6.7 CA3).
- **Avisos do Sentry RN 8.28 no Metro**: os 15 "The package … expo-router contains an invalid package.json configuration … router-store" vêm do `require('expo-router/build/global-state/router-store')` do próprio Sentry (`expoRouterStore.js`), um arquivo que o Expo Router 58 não tem mais. O `require` está num `try/catch` e o Metro o trata como dependência opcional: em execução devolve `null`, e só a integração de rotas do Expo Router no Sentry (que o app não usa) ficaria sem o nome da rota. São inofensivos e continuam até uma versão do `@sentry/react-native` compatível com o SDK 58 (não foram escondidos com um resolver próprio no Metro, para não fugir do padrão do ADR 0001). O aviso "Missing config for organization, project" do plugin não aparece (as chaves existem, vazias, no `app.config.ts`).
- Componentes novos no `packages/ui` (e no catálogo, seção "Notificações" e as telas p09 e p21 em "Telas compostas"): `NotificationRow`; o `IconButton` ganhou `dot` (o ponto azul) e o `Avatar` ganhou `countLabel` ("99+").
- **`p/[id]` de um reel** (pendência da 5b): o detalhe busca o post e, se for reel, troca a si mesmo pelo visualizador (`router.replace`); fechar volta para onde a pessoa estava.
- Casos cobertos no app: 6.1 CA1 (no app), 6.2 CA1, 6.3 CA1 e CA6 (no app), 6.4 CA1, CA2 (logout sem `DELETE`, com o servidor) e CA4, 6.5 CA5 e 6.6 CA1 (com o dublê do `expo-notifications`), 6.7 CA1, CA2 e CA4 no app; NOT-03 e A-35 (seções pelo fuso do aparelho), NOT-05 e NOT-06 no app, PERM-17 no app (evento com token, `Bearer`, JWT, push token, senha, e-mail, IP, cookies, listas de relacionamento e o @ nas URLs: nada sai), D11/A-07 (@ não tocável) e o reel no `p/[id]`.
- Demonstrado localmente (script de mutação fora do repositório; cada arquivo restaurado e conferido por SHA-256): tirar a validação do `PushDataSchema` antes de navegar derruba 7 testes; `sendDefaultPii: true` e o `beforeSend` sem limpeza derrubam o PERM-17 do app; o @ tocável com `profileVisible` falso derruba o D11; tirar o "não insistir" derruba o 6.4 CA4; registrar o token de quem não ativou derruba o teste do registro; o desligar sem o `DELETE` derruba 2 testes de Conta; o `POST /read` com outro `upTo` derruba o 6.2; o `p/[id]` sem o visualizador derruba o teste do reel (9 de 9).

Decisões (onde os documentos eram omissos; o mais conservador em privacidade):

- **Opt-in de verdade**: mesmo com a permissão do sistema já concedida (Android 12 ou menos, ou de outra instalação), o token só é registrado depois do "Ativar" ou de ligar em Conta.
- **Uma pergunta por conta neste aparelho**: a escolha é gravada antes de mostrar o Alert (fechar o app no meio não repete). Para ligar depois, só em Conta. "Ativar" sem conseguir o token (sem o `projectId` do EAS ou sem rede) volta para desligado, com o Toast "Não foi possível ativar as notificações agora. Tente de novo em Conta."
- **Desligar em Conta** é o lugar do `DELETE` (a 6.4 não tinha tela); no logout o app confia no servidor, que apaga o token da sessão na mesma operação.
- **Rota do push**: além do `PushDataSchema`, só a `url` igual à do `pushTargetUrl` para o tipo e a conta é aceita (um `data` com outra rota do app, mesmo válida, não navega).
- **Sentry**: sem release health (`enableAutoSessionTracking: false`), sem toques nos breadcrumbs e com o @ e os ids tirados das URLs e rotas (o `scrubTelemetryEvent` só tira a query). Ligar as sessões de release health fica para o PO.
- O `aps-environment` segue a variante; o `RECEIVE_BOOT_COMPLETED` foi removido (ver acima).
- Textos sem documento: "Avisamos neste celular quando alguém curtir, comentar ou se conectar com você. Dá para desligar em Conta." (criador: "Avisamos neste celular quando alguém curtir ou comentar e quando chegarem novos seguidores. Dá para desligar em Conta."), "Não foi possível ativar as notificações agora. Tente de novo em Conta.", "Notificações neste celular", "Curtidas, comentários, respostas e conexões. O texto dos comentários não aparece no aviso." (criador: "Curtidas, comentários, respostas e novos seguidores. O texto dos comentários não aparece no aviso."), "Não foi possível ativar as notificações. Tente de novo.", "Notificações bloqueadas", "Permita as notificações do Sussurro nos Ajustes do celular.", "Abrir Ajustes", "Abrir o perfil de @x" (leitor de tela), ", nova" no rótulo da linha não lida, o nome do canal do Android "Notificações", "Enviar erro de teste", "Erro de teste enviado ao Sentry." e "O Sentry está desligado (sem DSN)." (catálogo de dev).

Divergências do protótipo e dos documentos:

- p21: o texto dos seguidores fica todo em `body` ("2 novas pessoas" não fica em 600), porque o `notificationTextParts` devolve a frase inteira num pedaço só; mudar exigiria mudar o contrato do `packages/shared`.
- O pedido contextual é um Alert nativo (como as outras confirmações do app), com um texto de apoio; o ux.md só tinha o título e os botões.
- A linha "Notificações neste celular" em Conta não estava no wireframe 4.7 (registrada no ux.md, "atualizado na Fase 6").
- O título "Notificações" do p09 fica no `ScreenHeader` de sempre (`titleSm`, com voltar); o do criador (p21, sem voltar) fica em `titleLg`, como o Conectar.
- O `DELETE /me/push-tokens` não é chamado no logout (a pendência da 6a falava em "o `DELETE` antes do logout"): o servidor já apaga o token no logout.

Pendente:

- **Dev build EAS novo** (Android e iOS, conta Apple, A-02): entraram o `expo-notifications` e o `expo-application` (módulos nativos), as configurações de push (entitlement `aps-environment`, ícone, cor e canal do Android) e o plugin do Sentry (fases de build do source map no Xcode e no Gradle). Os builds anteriores não recebem push nem mandam source maps.
- **Contas e credenciais (nada no repositório)**:
  - EAS: projeto criado pelo PO em 2026-10-30 (id fixo no `app.config.ts`); faltam as credenciais de push: no iOS, a chave APNs pelo `eas credentials`; no Android, o projeto no Firebase, o `google-services.json` como variável de arquivo `GOOGLE_SERVICES_JSON` e a chave da conta de serviço do FCM v1 enviada ao EAS. O `.gitignore` agora barra `google-services.json`, `GoogleService-Info.plist` e `sentry.properties`.
  - Sentry: o projeto `sussurro-mobile`, `EXPO_PUBLIC_SENTRY_DSN` e `EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` por perfil, e `SENTRY_ORG`, `SENTRY_PROJECT` e `SENTRY_AUTH_TOKEN` (visibilidade **secret**) nas variáveis do EAS.
- **Aparelhos: MAN-PUSH-01** (com o dev build novo, a API e o worker com `PUSH_SENDER=expo` e a fila `push`: com Docker, ou no ambiente da Fase 7):
  1. Entrar com `helena@example.com` (pessoal) e publicar um texto: aparece "Quer saber quando alguém curtir ou comentar?". "Ativar" → o diálogo do sistema (no Android 13+, com o canal "Notificações") → permitir. No log da API, `PUT /v1/me/push-tokens` 204; em Conta, "Notificações neste celular" ligado.
  2. Fechar o app (tirar da lista de recentes). Com outra conta, comentar um post de helena: chega "lucasf comentou na sua foto." (sem o comentário). Tocar abre o app nas Notificações do Início, e o ponto do coração some.
  3. Repetir com o app em segundo plano e com ele aberto (banner sem som; o coração ganha o ponto).
  4. Com o app fechado, um pedido de conexão para helena (outro aparelho ou o "Simular um pedido recebido" de dev): "lucasf quer se conectar com você." abre o Conectar.
  5. Criador (`bia@example.com`): três follows no mesmo dia geram um push agrupado ("N novas pessoas começaram a seguir você.") que abre as Notificações do criador.
  6. Numa conta nova: "Agora não" no primeiro post e conferir que o segundo post não pergunta; noutra, negar no diálogo do sistema: nada quebra e não há novo pedido.
  7. Conta → desligar: `DELETE /v1/me/push-tokens` 204 no log; uma curtida depois disso não chega. Ligar de novo: volta a chegar.
  8. "Sair deste dispositivo": uma curtida depois disso não chega (sem `DELETE` no log: o logout apaga o token); entrar de novo registra outra vez.
  9. Android: ícone branco na barra de status; reiniciar o celular e conferir que o push ainda chega (sem o `RECEIVE_BOOT_COMPLETED`); conferir as permissões do APK (`aapt dump permissions`). iPhone: o push chega com o app fechado (APNs de produção no build do EAS).
  10. Sentry (preview com DSN e as três variáveis do upload): "Enviar erro de teste" no catálogo (`EXPO_PUBLIC_DEV_TOOLS=1`) e conferir no Sentry o stack com source maps, a release `app.sussurro.preview@…`, o ambiente `preview` e nenhum token, e-mail ou @ no evento.
- ~~**Com Docker** e **CI remoto**: os mesmos pendentes da 6a.~~ (atualizado em 2026-10-31) Resolvidos pelo CI (PR #4).
- **Política de Privacidade** (`C:\dev\sussurro-site`): a permissão de notificações, o token do aparelho e o que vai ao Expo, à Apple e ao Google pelo app, e o que o app manda ao Sentry, conforme o relatório da 6b.

### Fase 7: verificado × pendente

Terraform da produção (só código) e documentação de deploy (histórias 7.1 a 7.9; D12 e L3 como variáveis). Nada foi aplicado na AWS, nenhuma credencial foi usada e o custo AWS continua zero. Verificado em 2026-10-30, na máquina do PO (Windows 11, Node 26.13.0, pnpm 12.13.0), **sem Terraform, sem TFLint, sem Trivy, sem Docker e sem conta da AWS** (a proteção do ambiente não deixa baixar binários externos):

- Rodado em partes por causa da memória: `pnpm install --frozen-lockfile`; `pnpm format:check`; `pnpm turbo run lint typecheck --concurrency=1 --force` (15 tarefas, lint com 0 avisos); unitários com `--maxWorkers=2` (shared 189, db 13, api 163, worker 67, ui 221, mobile 357); `pnpm build --concurrency=1 --force` verde. Nenhuma dependência nova.
- **Terraform** em `infra/terraform` (layout do infra.md §6.2): `bootstrap` (state em S3 com lock nativo, orçamentos, OIDC do GitHub, zona do Route 53), `envs/prod` e 17 módulos (rede sem NAT, ECR, cluster, serviço genérico, ALB, RDS, Valkey, mídia, filas, MediaConvert, segredos, IAM, alarmes, SES, DNS, guarda de logs e orçamentos). Toda variável tem `description` e as de valor livre têm `validation`; há `versions.tf` em cada raiz e módulo, saídas documentadas e nenhum valor real: conta, domínio, e-mails e chaves só nos `*.tfvars` (fora do Git), com modelos `*.example` fictícios. Sem `terraform`, a forma foi conferida por um script fora do repositório que reproduz as regras de alinhamento e indentação do `terraform fmt` (81 arquivos, 0 problemas) e por revisão manual de cada arquivo.
- **Porte** (P5/D12): a variável `porte` (`enxuto`, o padrão, ou `completo`) escolhe a classe e o Multi-AZ do RDS, as tasks da API, o Spot do worker, o local dos segredos (SSM × Secrets Manager) e a classe dos logs.
- **L3** (Marco Civil, art. 15): `access_log_retention_enabled`, **desligada**. Ligada, cria um bucket privado, criptografado, só TLS, com leitura restrita a `access_log_reader_arns` e exclusão depois de 185 dias, e liga os logs do ALB nele.
- **Variáveis de produção** (`docs/deploy/variaveis.md`): os 63 nomes lidos pelos dois `env.schema.ts` têm a origem mapeada (conferido por script). As variáveis que o Terraform põe nas task definitions da API e do worker passaram pelo `loadApiEnv` e pelo `loadWorkerEnv` com `NODE_ENV=production` (valores fictícios); o `PREENCHER` dos segredos manuais no SSM e a falta do `MODERATION_EMAIL` são recusados no boot.
- **Imagens** (7.6): `apps/api/Dockerfile` e `apps/worker/Dockerfile`, multi-stage sobre `node:26.13.0-trixie-slim` fixado por digest, `pnpm deploy --prod`, usuário `node` (uid 1000), sem npm na imagem final, bundle de CAs do RDS em `NODE_EXTRA_CA_CERTS` e `.dockerignore` sem segredos, `docs`, `infra` nem o app. Sem Docker, os passos do pnpm foram simulados fora do Docker (pastas temporárias, apagadas no fim): contexto igual ao do `.dockerignore`, `pnpm install --frozen-lockfile --filter`, build e `pnpm deploy --prod` da API e do worker. A API só com as dependências de produção subiu contra o `pnpm db:pglite`: `/health` 200 e `/health/ready` 503 (Postgres `up`, Valkey `down`, o esperado sem Valkey); o worker subiu e ficou no ar.
- **Migration da produção**: `apps/api/src/migrate.ts` (`node dist/migrate.js`, com 6 testes) aplicou as 7 migrations no PGlite (exit 0), rodou de novo sem nada a fazer (exit 0), sem `DATABASE_URL` sai com 1 e, com erro de conexão, sai com 1 sem a senha no log.
- **CI**: job `infra` (`terraform fmt -check`, `validate` com `init -backend=false`, `tflint` com o ruleset da AWS e `trivy config` no Terraform e nos Dockerfiles, `--severity HIGH,CRITICAL`), sem credencial, sem `plan` e sem `apply`. Versões e SHAs conferidos nas fontes oficiais em 2026-10-30, todas com 14 dias ou mais: Terraform 1.16.6, `hashicorp/setup-terraform` v4.0.1 (`dfe3c3f…`, pela API do GitHub, tag e commit), `terraform-linters/setup-tflint` v6.3.2 (`6ffdbaa…`), TFLint v0.64.0 (SHA-256 do `checksums.txt` da release), ruleset da AWS 0.49.0 e Trivy 0.76.0 pela imagem com digest do Docker Hub (a `trivy-action` ficou de fora: teve as tags adulteradas em março de 2026, CVE-2026-33634). O Dependabot ganhou os ecossistemas `docker` e `terraform`.
- **Documentação**: `docs/deploy/runbook.md` (pré-requisitos, bootstrap, chave do CloudFront, primeiro apply sem serviços, imagens, segredos, usuários do banco, migrations, ligar os serviços, pós-apply, EAS, deploy de rotina, rollback, rotação de cada segredo, restauração, alarmes, troca de porte, L3 e custo), `docs/deploy/variaveis.md`, `docs/deploy/lojas.md` (perfis, `eas submit` e checklist das duas lojas) e `infra/terraform/README.md` (layout, porte, versões e os achados do Trivy aceitos, com a justificativa). `apps/mobile/eas.json`: perfil `production` com `distribution: store` e AAB, e `submit.production` com a trilha `internal` em rascunho no Android.

Ajuste no código da aplicação (o único): `apps/api/src/migrate.ts` e o teste `migrate.spec.ts`. A task de migration do deploy (infra.md §6.6) precisa de um ponto de entrada na imagem de produção, e o `drizzle-kit` é dependência de desenvolvimento, que não entra nela. O script usa o `runMigrations` que o `packages/db` já tinha para isso, só roda como `node dist/migrate.js` (`import.meta.main`) e nenhum teste existente mudou.

Decisões (onde os documentos eram omissos; a mais conservadora):

- **Deploy**: o Terraform registra uma revisão nova das task definitions a cada mudança e mantém as antigas (`skip_destroy`), mas não troca a do serviço (`ignore_changes`): quem troca é o `aws ecs update-service`, depois da migration. Rollback = voltar o serviço para a revisão anterior (infra.md §6.6).
- **Primeiro deploy em duas etapas**: `services_enabled = false` cria tudo menos os serviços; depois das imagens, dos segredos e das migrations, `true`.
- **Usuários do banco**: o mestre (senha gerenciada e rotacionada pelo RDS) só cria `sussurro_migrator` (dono do schema) e `sussurro_app` (só leitura e escrita de dados) numa task avulsa `db-bootstrap` (imagem oficial do PostgreSQL 18.6, por digest), idempotente; as senhas vêm do ambiente, nunca da linha de comando.
- **TLS do banco verificado**: `sslmode=verify-full` com o bundle de CAs do RDS na imagem. A `db-bootstrap` usa `sslmode=require` (a imagem do PostgreSQL não tem o bundle; a conexão não sai da VPC).
- **Segredos**: senhas do banco e token do Valkey gerados pelo Terraform (ficam no state, que é privado, criptografado e só de administrador); JWT, chave privada do CloudFront e token do Expo criados vazios e preenchidos à mão (fora do state). O `jwt-access-previous-secret` existe sempre e só é injetado na rotação.
- **Menor privilégio**: uma execution role por task, só com os segredos dela; o worker sem leitura em `media/*` e com `s3:ListBucket` (sem ele o S3 responde 403 em vez de 404 para objeto inexistente); a API envia só para `media-jobs` e `push`; a `video-events` nega o envio de qualquer um que não seja a regra do EventBridge.
- **Contêiner**: raiz só leitura com `/tmp` gravável, init do ECS, `stopTimeout` de 120 s no worker (o aviso do Spot) e logs `non-blocking`.
- **Alarmes de custo e OIDC no bootstrap**: valem antes de qualquer recurso pago. Os orçamentos ficam em us-east-1 (serviço global).
- `prod.tfvars` e `backend.hcl` fora do Git (têm a conta, o domínio e os e-mails). Recomendação: versionar o `prod.tfvars` quando os valores forem definitivos (não tem segredo).
- Performance Insights desligado por padrão (nem toda classe t4g aceita; variável `rds_performance_insights`).

Divergências do infra.md (registradas lá, §6):

- Uma execution role por task, em vez de uma só; nomes de bucket com o id da conta (`sussurro-prod-media-<conta>`); módulos novos `ses` (D6), `access-logs` (L3) e `budgets`.
- Terraform `~> 1.16.0` (o infra.md dizia `~> 1.16`, que aceitaria a 1.17) e provider AWS fixado em 6.69.1. (atualizado em 2026-10-31) O lock dos providers não precisa de credencial: o CI o gerou no PR #4, e ele está versionado nas duas raízes.
- O alarme "tasks abaixo do desejado" (`RunningTaskCount`) exige Container Insights (pago): no lugar, hosts saudáveis no ALB e idade das filas. O de erro do MediaConvert usa a métrica da própria AWS (`JobsErroredCount`), não uma métrica do worker.
- O DSN do Sentry é variável do Terraform (não é segredo), não um segredo do Secrets Manager.

Pendente:

- ~~**CI ou máquina do PO** (com Terraform, TFLint, Trivy e Docker): `terraform fmt -check`, `terraform validate` das duas raízes, `tflint`, `trivy config` (um achado alto ou crítico não previsto vira correção ou justificativa no código), `terraform providers lock` e o `.terraform.lock.hcl` versionado.~~ (atualizado em 2026-10-31) Resolvidos pelo CI: o job `infra` roda o fmt, o validate, o tflint e o trivy desde o PR #1, e no PR #4 gerou o `.terraform.lock.hcl` das duas raízes (`hashicorp/aws` 6.69.1 e `random` 3.9.1, com os hashes das cinco plataformas), que passou a ser versionado. Agora o `init` usa `-lockfile=readonly`.
- **`terraform plan`**: exige credencial da AWS e as decisões abaixo.
- ~~**Imagens**: build real das duas imagens (ARM64, `docker buildx`), `id` mostrando o usuário `node`, `/health/ready` 200 com o compose no ar e a migration pela imagem (runbook, passo 4; 7.6 CA).~~ (atualizado em 2026-10-31) Resolvido pelo job `images` do CI (PR #4, run 41234942342), em `ubuntu-24.04-arm`. Ele confere `arm64`, o usuário `node` e o uid 1000, roda a migration pela imagem duas vezes e recebe `/health/ready` 200 com Postgres e Valkey. Também sobe o worker em produção contra os emuladores, e os dois saem com 0 no `SIGTERM`, com a raiz só leitura. Falta a varredura do ECR, depois do `apply` (o `minimatch` e o `glob` já estão aceitos no runbook, passo 4).
- **Depois do apply autorizado**: os testes de fumaça do runbook §9 (PERM-16 no CloudFront, MID-14 em `testes.md` §8.2, e-mail pelo SES fora do sandbox, push e denúncia), o plano flat-rate do CloudFront, o DMARC, o monitor externo e o exercício de restauração.
- **Só o PO decide**: D12/P5 (região e porte; o padrão é `enxuto`), P6 (domínio e DNS no Route 53), P7 (orçamento), **L3** (guarda de registros de acesso, com o jurídico; os logs do ALB não dizem qual conta fez o acesso), L1 e L2 (Política de Privacidade e idade mínima, antes das lojas), o `EMAIL_LINK_BASE_URL` em produção (`sussurro://` hoje; https exige página ou universal links) e as contas (AWS, Apple, Google Play, Expo, Sentry e GitHub). Commit e push também.
- **App**: builds `preview` e `production` no EAS e o envio às lojas (`docs/deploy/lojas.md`); conferir no AAB se alguma biblioteca trouxe `READ_MEDIA_IMAGES` ou `READ_MEDIA_VIDEO`.
- **Política de Privacidade** (`C:\dev\sussurro-site`): o log técnico da API (30 dias) já guarda os cabeçalhos das requisições, inclusive o IP de origem (`X-Forwarded-For`) e o user agent; e, se o L3 for ligado, o texto do runbook §17.

### Fechamento do MVP (PRs #4 a #6): verificado × pendente

Plano do Tech Lead de 2026-10-31, a partir do inventário do `arquiteto`, aprovado pelo PO, que autorizou commit, push, PR e merge com o CI verde e as revisões aprovadas.

**PR #4** (`chore/fechamento-ci-docs`; CI, testes e docs, sem código de produto), verificado no run 41234942342:

- `images`: build ARM64 nativo das duas imagens, usuário `node`, migration pela imagem, `/health/ready` 200, o worker em produção e `SIGTERM` com saída 0 (ver Fase 7).
- `infra`: o `.terraform.lock.hcl` das duas raízes foi gerado pelo CI e versionado; agora o `init` usa `-lockfile=readonly`.
- `test`: 419 e2e da API, sem nenhum pulado, com os novos NOT-10 (follows simultâneos na notificação agrupada), NOT-11 (`SqsPushQueue` no ElasticMQ, com o `traceparent`) e NOT-12 (DLQ da fila `push`).
- `quality`:
  - exceção do `audit` para o `zod` do `@expo/cli`, com prazo em 2026-11-30;
  - paridade das imagens dos services com o compose;
  - services e compose fixados por digest.
- `CODEOWNERS` para os arquivos de política. Só tem efeito com o GitHub Pro e a proteção da `main`, decisão do PO.
- Docs com o estado real (README, `PROJETO.md`, `backlog.md`, `arquitetura.md`, ADRs 0001 a 0012 e `testes.md` §9.5, §10 e §10.9) e as decisões do PO de 2026-10-31 sobre a Fase 4d.
- `ux.md`:
  - §11.18 (PR #5) e §12 (PR #6);
  - recomendação do `ux-ui`, seguida pelo Tech Lead e reversível: não fazer na v1 o deslizar entre as abas do feed, porque o gesto briga com o carrossel de fotos, nem o "✓" depois de "Conectados", que era notação de wireframe.
- Revisões:
  - `seguranca`: aprovado, com aval à exceção do `audit`; o MÉDIO e os 3 BAIXOS foram corrigidos no próprio PR;
  - `testes`: aprovado com ressalvas, e a primeira execução real foi o CI.
- O que o CI ainda não cobre está no `testes.md` §10.9:
  - F0-API-03/04;
  - F0-DC-05/06;
  - `spike:aws`;
  - `seed:media`;
  - FEED-16;
  - os PRs negativos F0-CI-02/04.

**PR #5** (Fase 4d e dívidas registradas) e **PR #6** (fidelidade ao `ux.md`): em andamento.
