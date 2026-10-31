# Estratégia de testes e qualidade do Sussurro (v1)

> Autor: QA. Data: 2026-10-29. Status: **proposta para revisão do PO. Nenhum teste foi escrito nem executado** (não há código).
> Entradas: `briefing.md`, `arquitetura.md`, ADRs 0001 a 0011, `ux.md`, `fase-0-plano.md`, `backlog.md`, `infra.md`, protótipo `docs/design/prototipo/` (p-05, p-15 e `texto-extraido.txt` conferidos).
> Todos os arquivos pedidos existiam. Os critérios de aceite por história estão no `backlog.md` e citam os IDs dos casos deste documento (ex.: `PERM-10`).

## 0. Resumo

| Tema | Proposta |
|---|---|
| Camadas | Unidade (Vitest na API/worker/shared; Jest + jest-expo no app/ui) → integração com Postgres e Redis **reais** (compose no dev, services no CI) → e2e de API (supertest sobre a app Nest) → componentes do app (RNTL) → **testes manuais guiados em aparelhos físicos** (BLE, câmera/QR, push, upload, acessibilidade). |
| E2E automatizado no celular | **Fora da v1.** Sem Mac, sem emulador (7,7 GB de RAM) e com BLE impossível de automatizar. Reavaliar Maestro via EAS Workflows depois da Fase 6. |
| Testcontainers | **Não adotar na v1.** O compose já está no ar no dev e o CI usa services. Isolamento por banco clonado de template por worker do Vitest. Testcontainers vira plano B se houver flakiness por estado compartilhado. |
| Foco | Regras do servidor: permissões por tipo de conta, privacidade do grafo (canário), protocolo de proximidade, feed por janela, auth, mídia sem GPS. |
| Rastreio | Cada caso crítico tem um ID (`PERM-01`…). O ID vai no nome do teste: `it('[PERM-01] criador não segue ninguém', …)`. Um `grep` mostra a cobertura dos casos. |
| Pronto | DoD geral + DoD por fase (seção 9). O "roda no iOS e Android" vira checklist com evidência (print/vídeo + build EAS + SHA). |

---

## 1. Princípios

1. **A regra mora no servidor, então o teste também.** Toda regra de permissão tem teste de API (e2e com banco real). Teste de interface não substitui teste de servidor.
2. **Banco e Redis reais na integração.** Advisory lock, índice único parcial, FK composta, trigger, TTL e `ON CONFLICT` não são testáveis com mock.
3. **Sem `sleep` para testar tempo.** Relógio injetável (`Clock` provider no Nest) e TTLs configuráveis por env no ambiente de teste (ver 3.3).
4. **Teste que falha de propósito primeiro.** Para cada caso de permissão, o PR mostra que o teste falharia sem a regra (ex.: remover o guard localmente). Isso evita "teste que não testa nada".
5. **Fixtures compartilhadas entre app e API** quando a mesma regra existe nos dois lados (contagem de 280, limites de campo, formato de handle).
6. **Nada de dados reais.** Seeds com as personas do protótipo (helena, caio.r, marinac, cozinhadabia, trilhasdosul) e handles `canary_*` para os testes de vazamento.

---

## 2. Camadas, ferramentas e onde cada teste mora

| Camada | Ferramenta | Onde mora | O que cobre | Docker? | Roda em |
|---|---|---|---|---|---|
| Unidade (back) | Vitest 5 + `unplugin-swc` | ao lado do arquivo: `apps/api/src/**/*.spec.ts`, `apps/worker/src/**/*.spec.ts`, `packages/shared/src/**/*.test.ts`, `packages/db/src/**/*.test.ts` | services com dublês, `AccessPolicyService`, codec de cursor, contagem de caracteres, schemas Zod, normalização de handle/e-mail, cálculo de janela | não | `pnpm test` (local e CI) |
| Integração do banco | Vitest | `packages/db/src/**/*.int.test.ts` | migrations sobem do zero, FKs compostas, CHECKs, trigger de tipo imutável, índices únicos parciais, `uuidv7()` | Postgres | `pnpm test:e2e` |
| Integração da API | Vitest + `@nestjs/testing` | `apps/api/test/int/**/*.int-spec.ts` | repositórios e services contra Postgres/Redis reais: corrida A→B ∥ B→A, rate limit, TTL, feed SQL | Postgres + Redis | `pnpm test:e2e` |
| E2E de API | Vitest + **supertest** sobre `app.getHttpServer()` | `apps/api/test/e2e/**/*.e2e-spec.ts` | contrato HTTP completo: status, `{code,message}`, schemas de resposta, guards, canário, matriz de permissões | Postgres + Redis (+ S3/SQS a partir da Fase 2) | `pnpm test:e2e` |
| Worker | Vitest | `apps/worker/test/**/*.int-spec.ts` | consumidor `media-jobs` com ElasticMQ e SeaweedFS reais, strip de EXIF com fixtures, DLQ | Postgres + S3/SQS | `pnpm test:e2e` (Fase 2+) |
| Componentes (ui) | Jest 30 + jest-expo 58 + RNTL 14 | `packages/ui/src/components/**/*.test.tsx` | render, variantes, estados, `accessibilityRole/Label/State`, tokens travados (`theme.test.ts`) | não | `pnpm test` |
| App (telas, hooks, cliente) | Jest + jest-expo + RNTL + **MSW** (node) para HTTP; mocks do módulo nativo, `expo-camera`, `expo-secure-store` | `apps/mobile/src/**/*.test.ts(x)` | máquina de estados do Conectar, cliente HTTP (single-flight do refresh), contador 280, navegação por tipo de conta, estados vazio/erro/offline | não | `pnpm test` |
| Config do app | Jest | `apps/mobile/src/config/app-config.test.ts` | snapshot do `app.config.ts` por `APP_VARIANT`: `preview`/`production` **sem** cleartext/ATS liberado e sem rotas de dev (sugestão do `infra.md` §5.4) | não | `pnpm test` |
| Arquitetura | `dependency-cruiser` ou `no-restricted-imports` | config do ESLint | funções de listagem de relacionamento só importadas no `MeController` (ADR 0004); app não importa `@sussurro/db` | não | `pnpm lint` |
| Performance | `autocannon` (ou k6) + seed volumoso | `apps/api/test/perf/` | p95 do feed < 300 ms (arquitetura §1) | compose | manual, fim das Fases 2 e 3 |
| Manual guiado | roteiros + matriz de aparelhos (seção 8) | `docs/qa/roteiros/` (proposta) | BLE, QR, câmera, push, upload real (HEIC/GPS), VoiceOver/TalkBack, fonte 200%, rede ruim | aparelhos físicos | fim de cada fase |
| Nativo (Swift/Kotlin) | Kotlin: JUnit opcional no Gradle; **Swift: sem teste automatizado** (XCTest exige Mac) | `apps/mobile/modules/sussurro-proximity/` | lógica de montar/ler o UUID (prefixo + 12 bytes) | — | ver ambiguidade A-20 |

### 2.1 Por que supertest e não um cliente HTTP real
supertest chama o servidor HTTP do Nest em memória (porta efêmera), sem precisar subir a API em outro processo. Funciona igual no Windows e no Linux. O app Nest de teste usa o **mesmo `AppModule`** de produção, trocando só a config (banco de teste, TTLs curtos, `Clock` controlável).

### 2.2 Dados de teste
| Item | Onde | Conteúdo |
|---|---|---|
| Factories | `packages/db/src/testing/factories.ts` | `createUser({type})`, `connect(a,b,{method})`, `follow(p,c)`, `createPost({author,type,publishedAt,status})`, `deleteUser(u)` |
| Seed de dev | `pnpm db:seed` (Fase 1 em diante) | personas do protótipo, conexões e follows prontos, posts nas 72 h. **Necessário para testar o feed na Fase 2**, quando o app ainda não conecta nem segue (ver A-08) |
| Seed canário | `apps/api/test/fixtures/canary.ts` | Y (pessoal) conectado a `canary_conn_<rand>` e seguindo `canary_creator_<rand>` |
| Seed volumoso | `apps/api/test/perf/seed-volume.ts` | 1 leitor com 150 conexões e 500 criadores seguidos, 100 mil posts |
| Fixtures de mídia | `apps/worker/test/fixtures/media/` | `jpeg-gps.jpg` (EXIF+GPS+XMP+IPTC), `png-exif.png`, `webp-exif.webp`, `rotated-90.jpg`, `iphone.heic`, `bomb-30000px.png`, `html-as.jpg`, `zero-bytes.jpg`, `15mb-exato.jpg`, `15mb-mais-1.jpg` |
| Fixtures de texto | `packages/shared/src/text/count.fixtures.json` | casos de contagem (TXT-01), lidos pelos testes da API **e** do app |

---

## 3. Infraestrutura de testes

### 3.1 Isolamento do banco
- Banco de teste **separado** do banco de dev (`sussurro_test_*`), no mesmo Postgres do compose. Nunca rodar testes contra o banco `sussurro` de desenvolvimento.
- `globalSetup` do Vitest: aplica as migrations em `sussurro_test_tpl`. Cada worker cria `sussurro_test_<VITEST_POOL_ID>` com `CREATE DATABASE … TEMPLATE sussurro_test_tpl` (rápido) e apaga no fim.
- Entre testes: `TRUNCATE … RESTART IDENTITY CASCADE` das tabelas de domínio. **Não usar transação por teste**: os casos de corrida (PROX-13, CNT-04) precisam de várias conexões simultâneas.
- Redis: um índice de banco por worker (`redis://localhost:6379/<n>`) e `FLUSHDB` entre testes.

### 3.2 Testcontainers no Windows: avaliação
| Critério | Testcontainers | compose + services (proposto) |
|---|---|---|
| Windows 11 + Docker Desktop/WSL2 | funciona, mas sobe containers a cada execução (5 a 15 s cada) e o container Ryuk | o compose já está no ar no dev |
| RAM (7,7 GB) | containers duplicados em relação ao compose de dev | zero extra |
| Paridade com o CI | igual | igual (mesmas imagens e tags) |
| Isolamento | total | por banco clonado e índice Redis por worker |
| Esforço | biblioteca nova | nenhum |

**Decisão proposta:** não usar na v1. Plano B se surgirem testes intermitentes por estado compartilhado.

### 3.3 Tempo
- `Clock` injetável na API e no worker (`now(): Date`). Regras que dependem de tempo (`expires_at`, `since` do feed, bucket de notificação por dia) usam o `Clock`, **não** `now()` do Postgres. Sem isso, FEED-03 e PROX-15 não são testáveis de forma determinística (ver A-27).
- TTLs do Redis vêm de config: `PROX_TOKEN_TTL_S` (30), `PROX_RECENT_TTL_S` (120), `PROX_SCREEN_TTL_S` (30), `PROX_TOUCH_WINDOW_S` (**5**, ADR 0012 Adendo A2: o relato só casa se o **primeiro** relato do outro tem menos que isso; a observação `prox:o` = `"{primeiroMs}:{hash}"` vive o dobro, 10 s, **desde o último relato** (A2 rev. 1, R1-1: prazo deslizante, `PX` em todo relato, sem `KEEPTTL`; o `primeiroMs` não muda enquanto o observador relatar)), `PROX_TOUCH_PAIR_TTL_S` (60, validade do par encostado para pedir, `prox:m`, e do cartão devido, `prox:v`), `PRESIGN_PUT_TTL_S` (600). O ocupado (`prox:c`, 10 s) é `2 × PROX_TOUCH_WINDOW_S`, sem variável própria. A2-1, teto de pessoas novas por conta, nos dois lados do par, em janelas fixas: `PROX_TOUCH_PAIRS_PER_HOUR` (10) e `PROX_TOUCH_PAIRS_PER_DAY` (30), contadores `rl:prox-pairs:hour|day:{uid}`. A API não sobe se `PROX_TOUCH_PAIR_TTL_S + PROX_TOKEN_TTL_S > PROX_RECENT_TTL_S`, `PROX_TOUCH_WINDOW_S > PROX_TOKEN_TTL_S`, `PROX_TOUCH_WINDOW_S + 2 > PROXIMITY_TOUCH_REPORT_FOR_S` (8, o prazo do relato do app, contrato em `packages/shared`) ou `PROX_TOUCH_PAIRS_PER_DAY < PROX_TOUCH_PAIRS_PER_HOUR` (PROX-47). O sinal de abuso (A2-3) usa `rl:prox-block-after-touch:{blocker|blocked}:{uid}`, 3 em 7 dias, sem variável; (A2 rev. 1, R1-6) conta uma vez por casamento e por sentido, com a marca no valor do par (`prox:m` = `"{horário}"` ou `"{horário}:{a|b|ab|ba}"`, `KEEPTTL`). O limite do `touches` (60/min) vem de `PROXIMITY_TOUCH_LIMIT_PER_MIN`, no `packages/shared`. Nos testes de expiração, usar `PEXPIRE` na chave para forçar a expiração, ou TTL de 1 s. Nos e2e, o fake em memória (`TestProximityStore`) vence as chaves pelo `FakeClock`; `failing` derruba só uma operação do store (PROX-35, PROX-54, PROX-61); `stalling` deixa uma operação sem resposta, e quem chama desiste nos 500 ms do `withTimeout` (o Valkey lento, PROX-61 e PROX-62; meio segundo de relógio de verdade por chamada); `claims` registra o resultado de cada casamento (`created`, `renewed`, `capped`, `busy`, `gone`), que a rota não distingue de propósito (PROX-46); e `blockSignals` registra o resultado de cada `countBlockSignal` (os dois contadores, ou `null`), que o 204 do bloqueio não mostra (PROX-55, PROX-63). O fake só lê os contadores do teto somando 1 (`hit`); os e2e fazem essa leitura só quando a conta não casa mais no teste.
- Rate limit nos e2e (2026-10-30, falha do CI do PR #1): o teste avança o `FakeClock` e espera a janela reiniciar. No modo real a janela vive no TTL do Valkey (relógio de verdade), então o `test-app` usa o store de produção dentro do `ClockSyncedRateLimitStore` (`apps/api/src/testing`), que desconta do TTL das chaves `rl:*` o tempo que o `FakeClock` andou. No PGlite vale o fake em memória; `TEST_RATE_LIMIT_STORE=valkey-sim` reproduz o caminho do modo real sem Docker (dublê `WallClockRedis`).
- `TZ=UTC` nos testes do Node (setado no `vitest.config.ts` e no `jest.setup.ts`). Testes de "dia em America/Sao_Paulo" passam o fuso explicitamente.
- Atenção: os testes do app rodam no Node, e o app roda no Hermes. Formatação de data e `Intl` podem divergir. Conferir "Há 18 minutos", "ontem" e "27 out" no aparelho (roteiro manual).

### 3.4 Como rodar no Windows (PowerShell, raiz `C:\dev\sussurro`)
| Objetivo | Comando |
|---|---|
| Unitários de tudo (sem Docker) | `pnpm test` |
| Integração + e2e | `docker compose up -d --wait` e depois `pnpm test:e2e` |
| Um pacote | `pnpm --filter @sussurro/api test` |
| Um arquivo ou caso | `pnpm --filter @sussurro/api exec vitest run feed` ou `-t "PERM-10"` |
| App e ui | `pnpm --filter @sussurro/mobile test` / `pnpm --filter @sussurro/ui test` |
| Cobertura | `pnpm test:cov` (proposta: `turbo run test -- --coverage` + e2e com cobertura na API) |
| Tudo o que o CI roda | `pnpm check` + `pnpm test:e2e` |

### 3.5 CI (GitHub Actions)
- Job `test` com services `postgres:18.6-bookworm` e `valkey/valkey:8.1-alpine`. Ele deve rodar **`pnpm test` e `pnpm test:e2e`**. Hoje o `infra.md` §4.1 só chama `turbo run test`, e o plano do Dev separa o e2e em `test:e2e` (ver A-24).
- A partir da Fase 2: `docker compose up -d --wait elasticmq seaweedfs s3-init` no mesmo job.
- Relatórios: JUnit XML (Vitest e Jest) e cobertura (lcov) como artefato. Falha de teste ou de limite de cobertura deixa o job vermelho.
- Testes intermitentes: proibido `retry` global. Teste instável vai para quarentena com issue aberta e prazo.

---

## 4. Metas de cobertura por pacote

Metas realistas, com foco em regra de negócio. Valem a partir da Fase 1 (na Fase 0 basta o CI medir e publicar). Regra adicional: **a cobertura de um pacote não pode cair num PR** (ratchet).

| Pacote | Linhas | Ramos | Observação |
|---|---|---|---|
| `packages/shared` | 90% | 85% | schemas, contagem de caracteres, codec de cursor: tudo puro |
| `apps/api` módulos `policies`, `auth`, `proximity`, `connections`, `follows`, `feed` | 90% | 85% | unidade + e2e somados. São as regras críticas |
| `apps/api` total | 80% | 70% | infra técnica pesa menos |
| `apps/worker` | 75% | 65% | consumidores e transições de status |
| `packages/db` | sem meta de linhas | — | **100% das constraints, triggers e índices únicos** com teste de integração (lista em PERM-06) |
| `packages/ui` | 70% | 60% | 100% dos componentes com teste de render, variantes e a11y |
| `apps/mobile` `src/lib` e `src/features` | 60% | 50% | máquina de estados do Conectar e cliente HTTP ≥ 90% de ramos; telas sem meta |
| Módulo nativo `sussurro-proximity` | — | — | coberto por roteiro manual (seção 8) |

Mutation testing (Stryker) no `AccessPolicyService` é opcional, na Fase 3, se o PO quiser uma prova extra de que os testes de permissão realmente detectam regressões.

---

## 5. Não funcionais

### 5.1 Segurança (OWASP Top 10 aplicado)
| Risco | Onde | Casos |
|---|---|---|
| A01 Controle de acesso quebrado (IDOR) | todas as rotas com `:id`/`:handle` | PERM-*, matriz de 404 (PERM-13, PERM-14), canário (PERM-10) |
| A02 Falhas criptográficas | tokens, senhas, URLs | AUTH-02 (argon2id), PROX-01 (só hash no Redis), MID-07 (presign) |
| A03 Injeção | busca por prefixo, cursor | BUS-06 (curingas `_`/`%`), FEED-08 (cursor adulterado) |
| A04 Design inseguro | proximidade | PROX-09 a PROX-12 (tokens cruzados, replay); PROX-31 a PROX-43 (encostar: canal do token, encosto mútuo, par, sem dado de sinal; ADR 0012); PROX-44 (campo TX declarado ignorado, A1); PROX-45 a PROX-56 (teto de pessoas novas, revelação garantida, rótulo, ocupado, sinal de abuso; A2); PROX-57 a PROX-64 (prazo deslizante, um relato por vez, orçamento, cartão devido antes das recusas, bloquear e denunciar pelo cartão, sinal por sentido, `pairExpiresInS`; A2 rev. 1) |
| A05 Configuração | app e API | config por variante sem cleartext; `/dev/*` ausente em produção (PROX-30, PROX-42, F0-APP-05) |
| A07 Autenticação | auth | AUTH-06 a AUTH-12 |
| A08 Integridade | uploads | MID-04 (magic bytes), MID-06 (bomba de descompressão) |
| A09 Logs | pino e Sentry | PERM-17 |
| Abuso | rate limits | AUTH-07, PROX-20, PROX-34, PROX-59, PROX-60, BUS (limite a definir, A-31) |
| Segredos | repositório | gitleaks no CI (F0-CI-03) |

### 5.2 Performance
- Feed p95 < 300 ms no servidor (FEED-16), busca p95 < 150 ms (proposta), resolve de proximidade p95 < 200 ms (proposta: a descoberta precisa parecer instantânea).
- Medido localmente com seed volumoso no fim das Fases 2, 3 e 4. Não roda por PR.

### 5.3 Acessibilidade (alvo do `ux.md`: WCAG 2.2 AA)
- Automático: todo componente do `packages/ui` tem teste com `getByRole`/`getByLabelText` (se o teste não acha pelo papel, o leitor de tela também não acha). Contrastes dos tokens travados em `theme.test.ts` contra a tabela do `ux.md` §7.1.
- Manual por fase: VoiceOver e TalkBack nos fluxos da fase, fonte do sistema no máximo, Reduzir movimento ligado.

---

## 6. Casos críticos (numerados)

Legenda da coluna Camada: **U** unidade, **I** integração com banco/Redis, **E** e2e de API, **C** componente/app, **M** manual em aparelho. "Fase" = quando o teste passa a ser obrigatório.

### 6.1 Permissões aplicadas no servidor (PERM)
| ID | Cenário | Resultado esperado | Camada | Fase |
|---|---|---|---|---|
| PERM-01 | Criador chama `PUT /creators/:h/follow` | 403 `ACCOUNT_TYPE_NOT_ALLOWED`; nenhuma linha em `follows` | E | 3 |
| PERM-02 | INSERT direto em `follows` com seguidor criador ou alvo pessoal | o banco recusa (FK composta); o filtro converte o erro em 403, nunca 500 | I | 3 |
| PERM-03 | Pessoal chama `PUT /creators/{handle_de_pessoal}/follow` | **404 idêntico** (status, `code`, corpo) ao de um handle inexistente. Não pode ser 403 "não é criador", que revelaria a conta | E | 3 |
| PERM-04 | Pessoal segue criador duas vezes; deixa de seguir sem seguir antes | 1 linha só; o segundo follow e o unfollow sem follow são idempotentes (2xx, sem erro) | E | 3 |
| PERM-05 | Criador chama **cada** rota de conexão/proximidade/feed/busca/seguir (`POST /proximity/tokens`, `/proximity/resolve`, `POST /connections/requests`, `GET …/incoming`, `GET …/:id`, `…/accept`, `…/decline`, `DELETE …/requests/:id`, `DELETE /connections/:handle`, `GET /feed`, `GET /search/creators`, `PUT/DELETE /creators/:h/follow`, `GET /me/connections`, `GET /me/following`) | 403 `ACCOUNT_TYPE_NOT_ALLOWED` em todas. O teste lê a lista de rotas do `DiscoveryService` e **falha se uma rota desses módulos não tiver `@RequireAccountType('personal')`** | E | 3 (proximidade: 4) |
| PERM-06 | Integridade no banco: conexão/pedido com um lado criador; `user_a_id >= user_b_id`; `from_id = to_id`; `UPDATE users SET account_type` | todos recusados pelo banco (FK, CHECK, trigger) | I | 1 (users/trigger), 3, 4 |
| PERM-07 | `PATCH /me` com `accountType`, `handle`, `email`, `id`, `createdAt` | campos ignorados ou 400 (definir: proposta **400** por `strict()` do Zod); nada além de `name`/`bio` muda | E | 1 |
| PERM-08 | `GET /me/connections` e `/me/following` com `?userId=`, `?handle=` ou header forjado | sempre a lista do `sub` do JWT; parâmetros extras rejeitados (400) ou ignorados | E | 3 |
| PERM-09 | Inventário de rotas | teste estático: nenhuma rota com `:id`/`:handle` declara schema de resposta com lista de usuários, exceto uma allowlist revisada (`/me/*`, `/proximity/resolve`, `/connections/requests/incoming`, busca) | U | 3 |
| PERM-10 | **Teste canário (ADR 0004).** Seed: Y (pessoal) conectado a `canary_conn_<rand>` e seguindo `canary_creator_<rand>`. O teste enumera **todas** as rotas GET pelo `DiscoveryService`, preenche os parâmetros por um mapa de fixtures (Y, posts de Y, comentários de Y) e chama cada uma como: X1 (conexão de Y), X2 (pessoal desconhecido), X3 (criador qualquer), anônimo | nenhum corpo, header ou mensagem de erro contém `canary_conn_` nem `canary_creator_`. Exceções: Y chamando `/me/*`; rotas cujo alvo explícito é o próprio criador canário (`GET /users/canary_creator_*`, busca com prefixo `canary`), listadas numa allowlist. **Rota GET sem fixture de parâmetro faz o teste falhar**, para forçar quem cria a rota a incluí-la | E | 3 (roda em todo PR depois) |
| PERM-10b | Canário nos POST/PUT seguros (`/proximity/resolve`, `/connections/requests`, `/auth/login`, `/auth/refresh`) | mesma verificação. O ADR fala só de GET, mas respostas de POST também vazam | E | 3/4 |
| PERM-10c | Vazamento por comentário (D11) | caso documentado: se `canary_conn` comentar num post de Y, X1 vê o @. O teste fixa o comportamento que o PO decidir em D11 | E | 2/3 |
| PERM-11 | Snapshot dos schemas públicos de resposta | `PublicProfile` só com `counts: {posts, connections, creators}` ou `{posts, followers}`; mudança exige atualizar o snapshot no PR | U | 1 |
| PERM-12 | Interceptor de resposta | rota sem schema declarado → 500 `INTERNAL_ERROR` (falha fechada); campo não declarado é removido da saída | E | 1 |
| PERM-13 | `GET /users/:handle` de pessoal por: dono, conexão, pessoal não conectado, criador, handle inexistente, conta excluída | 200, 200, **404**, **404**, 404, 404. Os 404 têm corpo idêntico | E | 1 (dono/inexistente), 3/4 (conexão) |
| PERM-14 | Post de pessoal (`GET /posts/:id`, comentários, curtir, comentar) por não conexão; post de criador por qualquer autenticado | 404 nas quatro operações para não conexão; 200 para post de criador | E | 2 |
| PERM-15 | Curtidas | nenhuma rota devolve quem curtiu; item tem só `likeCount` e `likedByMe` | E | 2 |
| PERM-16 | URL de mídia de conta pessoal | só é emitida para quem passa no `AccessPolicyService`; URL com assinatura adulterada ou sem assinatura → 403 no S3/CloudFront | E + M | 2 |
| PERM-17 | Logs e Sentry | requisição com `Authorization`, `password`, `token`, `observedToken`, `targetToken`: nenhum aparece no log (teste do `redact` do pino) nem no evento do Sentry (teste do `beforeSend`) | U | 1 (log), 6 (Sentry) |
| PERM-17b | Erro do banco no log e no Sentry (`DrizzleQueryError`) | o banco falha de verdade (PGlite: CHECK violada no cadastro e no `PATCH /me`, coluna fora no login, banco derrubado) numa rota com e-mail, senha, nome e bio: o 500 é o de sempre e nem o log (pino de produção, nível `trace`) nem o envelope do Sentry (opções de produção, transporte falso) contêm e-mail, senha, hash, nome, bio, `params:` ou o `detail` (`Failing row contains`); o SQLSTATE e os frames da aplicação continuam. Unitários: `sanitizeError`/`describeSafeError` (cadeia de `cause`, `AggregateError`, não-`Error`, `detail`, frame imitado), filtro, consumidor da fila, manutenção, recibos do push e desligamento | E + U | 6 |
| PERM-18 | Rotas sem autenticação | todas as rotas, exceto `/health*`, `/auth/register`, `/auth/login`, `/auth/refresh` e, desde a Fase 1 (D6), `/auth/password/forgot`, `/auth/password/reset` e `/auth/email/verify`, respondem 401 sem token (enumeradas pelo `DiscoveryService`) | E | 1 |

### 6.2 Contadores (CNT)
| ID | Cenário | Resultado esperado | Camada | Fase |
|---|---|---|---|---|
| CNT-01 | Perfil pessoal | `posts` = publicados e não excluídos (todos os tipos; definir, A-30); `connections` = conexões com contas não excluídas; `creators` = follows de criadores não excluídos | E | 1 (zeros), 2, 3, 4 |
| CNT-02 | Perfil de criador | `followers` = follows de pessoais não excluídos. Com o cache de 60 s, o valor fica correto em até 60 s (teste com relógio/cache invalidado); o contador `creators` de quem seguiu muda **na hora** | E | 3 |
| CNT-03 | Conexão criada; follow/unfollow; conta de B excluída | +1 nos dois lados; ±1; contadores de A caem **imediatamente** na exclusão (não só no hard delete) | E | 3/4 |
| CNT-04 | `like_count`/`comment_count` | curtir 2x = 1; descurtir sem curtida não fica negativo; 50 curtidas paralelas de 50 usuários = 50; excluir comentário decrementa; hard delete de quem curtiu **ajusta** o contador (hoje o `ON DELETE CASCADE` não ajusta, A-12) | I/E | 2 |
| CNT-05 | Rascunho, `processing`, `failed` | não contam em `posts` | E | 2 |

### 6.3 Busca (BUS)
| ID | Cenário | Resultado esperado | Camada | Fase |
|---|---|---|---|---|
| BUS-01 | `q` com 0, 1, 2 e 3 caracteres | 0–2 → 400 `VALIDATION_ERROR`; 3 → 200 | E | 3 |
| BUS-02 | `q="@ab"` / `q="@abc"` | o `@` inicial é removido antes de contar: 400 / busca `abc` | U/E | 3 |
| BUS-03 | `q=" Estu "` | normalizado para `estu` (trim + minúsculas) | U | 3 |
| BUS-04 | Seed com pessoal `estudante` e criador `estudioaurora`; `q=estu` | só `estudioaurora` | E | 3 |
| BUS-05 | `q` = handle **exato** de conta pessoal | `[]`, com status, corpo e headers idênticos aos de um handle inexistente. Tempo de resposta indistinguível (diferença de mediana em 50 amostras abaixo do ruído, indicativo) | E | 3 |
| BUS-06 | `q="a__"`, `q="a%b"`, `q="abc'--"` | `_` tratado como literal (LIKE com escape), não como curinga; caracteres fora de `[a-z0-9._]` → 400; sem erro 500 | E | 3 |
| BUS-07 | 25 criadores com o mesmo prefixo | 20 resultados, ordem alfabética do @, estável entre chamadas | E | 3 |
| BUS-08 | Criador excluído; criador chamando a busca | não aparece; 403 | E | 3 |
| BUS-09 | `q` ausente, vazio ou com mais de 30 caracteres | 400. Nunca há lista "sugerida" | E | 3 |
| BUS-10 | Schema do item | só `handle`, `name`, `avatar`, `followersCount`, `followedByMe` | U | 3 |
| BUS-11 | Tela Pesquisar com 1–2 letras | mostra "Digite pelo menos 3 letras." e **não** chama a API; sem resultado mostra a dica sobre contas pessoais (texto do D-UX5) | C | 3 |

### 6.4 Feed (FEED)
| ID | Cenário | Resultado esperado | Camada | Fase |
|---|---|---|---|---|
| FEED-01 | Leitor com conexão (como `user_a` e como `user_b`), criador seguido, pessoal não conectado, criador não seguido | aparecem só conexões (dos dois lados do par) e criadores seguidos (+ o próprio leitor se D9 = sim) | E | 2 (seed), 3 |
| FEED-02 | Ordem | `published_at DESC`, empate por `id DESC`; foto criada há 2 h e publicada agora entra pelo `published_at` | E | 2 |
| FEED-03 | Janela com `FEED_WINDOW_HOURS=72` e relógio fixo | post a exatamente 72h00m00s → **incluído** (`>=`); 72h00m01s → excluído; 71h59m59s → incluído | E | 2 |
| FEED-03b | Janela configurável | com `FEED_WINDOW_HOURS=1` o corte passa a 1 h; valores inválidos (`0`, `-1`, `abc`, vazio) → a API não sobe (Zod no boot) | E/U | 2 |
| FEED-04 | `windowHours` | resposta traz o valor da config; o `CaughtUp` monta o texto (72 → "últimos 3 dias", 24 → "último dia", 36 → "últimas 36 horas") | E/C | 2 |
| FEED-05 | Abas | `type=photo|text|reel` filtra; `type` ausente/inválido → 400; `reel` antes da Fase 5 → lista vazia com `caughtUp=true` (definir) | E | 2 |
| FEED-06 | Paginação | 45 posts, `limit=20` → 20, 20, 5; `nextCursor=null` e `caughtUp=true` na terceira; a união das páginas é exatamente o conjunto esperado, **sem duplicatas e sem lacunas**. Bordas: 0, 20, 21 e 40 posts | E | 2 |
| FEED-07 | Mudanças entre páginas | (a) post novo publicado entre a página 1 e a 2 não aparece na 2 nem duplica; (b) post da página 2 excluído não aparece e nada é pulado; (c) com `since` fixo no cursor, post que "envelhece" além de 72 h durante a rolagem continua aparecendo até o fim daquela sessão de rolagem | E | 2 |
| FEED-08 | Cursor | base64 inválido ou adulterado → 400; `since` mais antigo que janela + 1 h → limitado pelo servidor (não estende a janela); cursor de outra aba → 400 (o cursor deve carregar o `type`) | E | 2 |
| FEED-09 | `limit` | > 50 → limitado a 50; 0 ou negativo → 400 | E | 2 |
| FEED-10 | Status | `deleted_at`, `draft`, `processing`, `failed` nunca aparecem | E | 2 |
| FEED-11 | Deixou de seguir / desfez conexão (D8) | posts somem na próxima requisição, inclusive usando um cursor antigo | E | 3 (4 se D8) |
| FEED-12 | Autor excluído | posts somem **na hora** (hoje a SQL da arquitetura §8 não filtra `users.deleted_at`, A-11) | E | 2 |
| FEED-13 | Criador chama `/feed` | 403 | E | 2 |
| FEED-14 | App | `caughtUp=true` mostra "Você está em dia" em cada aba; sem conexões nem follows mostra o EmptyState "Seu início está vazio"; falha na página 2 mostra "Não carregou. Tentar de novo" sem perder a página 1 | C | 2 |
| FEED-15 | Schema do item | sem lista de curtidores; autor com rótulo `Conexão`/`Criador`; mídia só `ready`, com URL assinada | U/E | 2 |
| FEED-16 | Performance | p95 < 300 ms com o seed volumoso | perf | 2/3 |

### 6.5 Proximidade e conexão presencial (PROX)
| ID | Cenário | Resultado esperado | Camada | Fase |
|---|---|---|---|---|
| PROX-01 | Emissão de token por pessoal | 16 caracteres base64url (12 bytes), `expiresAt ≈ now+30 s`; o Redis guarda só o SHA-256 (o teste varre as chaves e não encontra o token em claro) | E/I | 4 |
| PROX-02 | **TTL de 30 s** | `resolve` com o token aos 29 s → resolve; aos 31 s → mesma resposta de token inexistente | I/E | 4 |
| PROX-03 | Janela "recente" de 120 s | aceite com `observedToken` de 31 a 120 s → aceito; > 120 s → recusado (ADR 0012: só no aceite `qr`; no pedido `ble`, o alvo pode ser "recente" com o par, PROX-39) | I/E | 4 |
| PROX-04 | `resolve` sem a tela aberta (`prox:u` do chamador ausente) | recusado com código próprio (ex.: 409 `PROXIMITY_SCREEN_CLOSED`) | E | 4 |
| PROX-05 | `resolve` | não devolve o próprio chamador nem tokens inválidos; `alreadyConnected` correto; lista de entrada limitada (ex.: 20 tokens). ADR 0012: só o `qrToken` resolve (PROX-33) | E | 4 |
| PROX-06 | Pedido A→B com `tB` válido | 201 `pending`, `expires_at = now+120 s`, `method` gravado | E | 4 |
| PROX-07 | **Pedido a si mesmo** (token próprio, inclusive gerado por outro aparelho da mesma conta) | 400/409 `CANNOT_CONNECT_SELF`; nada gravado | E | 4 |
| PROX-08 | **Criador tentando** (todas as rotas de proximidade e conexão) | 403 (coberto também por PERM-05) | E | 4 |
| PROX-09 | **Tokens cruzados no aceite** | B aceita com `observedToken = tA` → conectado; sem `observedToken` → 400; com token **de C** (válido, mas dono ≠ `from_id`) → recusado e o pedido continua `pending`; com `tA` > 120 s → recusado. ADR 0012: vale só no método `qr` (`tA` = `qrToken` de A); o aceite `ble` dispensa o token (PROX-41) | E | 4 |
| PROX-10 | Aceite sem a tela aberta de B (`prox:u:B` ausente) | recusado | E | 4 |
| PROX-11 | **Replay** | (a) `observedToken` reaproveitado em pedido de outra pessoa → recusado; (b) `tB` capturado e reenviado após 30 s → recusado; (c) repetir o `accept` do mesmo pedido → idempotente (mesma resposta, 1 linha); (d) token com 1 caractere alterado → inexistente | E | 4 |
| PROX-12 | **Token de outra pessoa / pedido de outra pessoa** | C tenta aceitar pedido A→B → 404 (não é o `to_id`); C tenta ler `GET /connections/requests/:id` de A→B → 404; B tenta cancelar pedido de A → 404 | E | 4 |
| PROX-13 | **Pedidos simultâneos A→B ∥ B→A** (`Promise.all`, 50 repetições contra Postgres real) | sempre exatamente 1 linha em `connections`, 0 pendentes, as duas respostas indicam `connected` (ou uma `connected` e o polling da outra devolve `accepted`) | I/E | 4 |
| PROX-14 | Aceite duplo concorrente (dois toques) | 1 conexão; respostas iguais | I/E | 4 |
| PROX-15 | **Expiração do pedido** | aceite com relógio em `expires_at + 1 s` → 410 `REQUEST_EXPIRED`; status vira `expired`; `GET …/:id` para A devolve o mesmo estado de uma recusa ("não confirmado"); o job marca os vencidos | E | 4 |
| PROX-16 | Pendente único por par | A→B pendente e novo A→B → devolve o mesmo pedido (ou 409; definir); depois de expirar, novo pedido é aceito | E | 4 |
| PROX-17 | Recusa e cooldown | depois do `decline`, novo A→B em menos de 1 h → erro **com a mesma mensagem** de token inválido (não revela recusa); B→A continua permitido (definir, A-34) | E | 4 |
| PROX-18 | Cancelamento | A cancela; B aceita o cancelado → 404/409; só A cancela | E | 4 |
| PROX-19 | **Conexão duplicada** | já conectados → 409 `ALREADY_CONNECTED`; aceite tardio de pedido já resolvido não duplica (`ON CONFLICT`) | E | 4 |
| PROX-20 | **Rate limit** | 7º token/min, 31º resolve/min, 11º pedido/min, 51º pedido/dia, 11º aceite/min → 429 com `Retry-After`; 20 falhas de token em 10 min → bloqueio de 15 min (também para QR); o limite é por usuário (outro usuário não é afetado) | E | 4 |
| PROX-21 | Redis fora | rotas de proximidade (inclusive `touches`, ADR 0012) → 503 `PROXIMITY_UNAVAILABLE` (fail-closed); login, feed e perfil continuam respondendo. Falha em cada passo novo do encostar: PROX-35 | E | 4 |
| PROX-22 | **Método `ble|qr`** | gravado no pedido e na conexão; valor fora do enum → 400; na corrida com métodos diferentes, a conexão fica com o método do pedido aceito (definir) | E | 4 |
| PROX-23 | B já tem pedido pendente de C; A envia para B | permitido (o pendente único é por par) | E | 4 |
| PROX-24 | QR | payload `sussurro://c/{token}`; QR com token vencido → mensagem amigável; deep link sem sessão descartado após 30 s; QR cruzado se D7 = (a) | C + M | 4 |
| PROX-25 | Rotação durante a escolha | `tB` rotaciona entre o `resolve` e o toque em "Conectar": o app envia o token mais recente observado para B; se não houver token válido, mostra "Caio saiu de perto". ADR 0012: no `ble`, o app usa o token do cartão do casamento, que vale "recente" enquanto o par vale (PROX-39) | C | 4 |
| PROX-26 | `observedToken` envelhecendo com a folha aberta | B continua varrendo e envia o `tA` mais recente; aceite aos 110 s do pedido com `tA` visto há 15 s → aceito (ver A-16). ADR 0012: deixa de valer no `ble` (o aceite dispensa o token e a folha não varre); no `qr`, é o `qrToken` lido de novo do QR de A | C + E | 4 |
| PROX-27 | Conta excluída ou logout durante o pedido | aceite → 404; tokens de proximidade do usuário invalidados | E | 4 |
| PROX-28 | Privacidade do anúncio BLE | sem nome do aparelho e **sem o campo TX Power, nos dois sistemas** (ADR 0012, A1: o Android anuncia em `high` com `setIncludeTxPowerLevel(false)` fixo; o iOS nunca põe o campo), só o UUID com o prefixo; troca a cada 20 s; para em background e ao sair da tela (verificado com nRF Connect, MAN-BLE-05 e spike 4.1-B). Registrar também o endereço Bluetooth do anúncio (R17): se o Android troca a cada `startAdvertising` e quanto dura o do iPhone (MAN-BLE-06, parte 3) | M (+ C no app: `radio.test.ts`, `connect.test.tsx`) | 4 |
| PROX-29 | Notificação `connection_created` | criada para os dois | E | 6 |
| PROX-30 | `/dev/simulate-request` | rota não registrada com `NODE_ENV=production` (404) | E | 4 |

**Conectar encostando (ADR 0012, 2026-10-30).** Substitui o `resolve` por Bluetooth e o token único: cada emissão traz um `bleToken` (só no anúncio) e um `qrToken` (só no QR), e um `bleToken` só vira pessoa quando os dois aparelhos relatam o encosto um do outro (`POST /proximity/touches`) dentro de `PROX_TOUCH_WINDOW_S`. Os casos abaixo valem a partir da Fase 4 (revisada).

| ID | Cenário | Resultado esperado | Camada | Fase |
|---|---|---|---|---|
| PROX-31 | **Dois tokens por emissão** | `POST /proximity/tokens` devolve `{bleToken, qrToken, expiresAt, renewInS}`, sem o campo antigo `token`: dois tokens distintos de 16 caracteres (12 bytes), com a mesma validade (30 s) e a mesma rotação (20 s); o Redis guarda só os hashes, cada um com o canal no registro (`{uid, iat, ch}`); registro sem canal válido vale como inexistente; o limite de 6/min conta a emissão, não cada token | U/I/E | 4 |
| PROX-32 | **Encosto mútuo** (`touches`) | A relata o `bleToken` de B → `items: []`; B relata o de A dentro da janela (`PROX_TOUCH_WINDOW_S`, **5 s contados do primeiro relato de A** (A2): 4,999 s casa; 5 s não, mesmo com a chave de A ainda viva) → B recebe o cartão de A e o par é gravado (`prox:m`, `PROX_TOUCH_PAIR_TTL_S`, 60 s desde o casamento); A recebe o de B no relato seguinte **pelo cartão devido** (`prox:v`, A2-2): é uma entrega, não um casamento novo, e não renova o par (revelação simétrica). Relato de um lado só → sempre `[]`, sem par; relatar o token de C não revela B nem C; token vencido (> 30 s), inexistente, alterado, do QR ou do próprio chamador → ignorado em silêncio (sem observação gravada), com a resposta de qualquer não mútuo. O `bleToken` lido do ar sem encosto mútuo não revela nada (`touches` → `[]`; pedido → 400, PROX-39) | U/I/E | 4 |
| PROX-33 | **`resolve` só do QR** | `resolve` com o `bleToken` válido → `items: []`, a mesma resposta de token inexistente, sem contar falha; o `qrToken` do mesmo dono resolve; com os dois juntos, só o do QR vira cartão | U/E | 4 |
| PROX-34 | **Limites e condições do `touches`** | (A2 rev. 1) sem cartão devido; com ele, o cartão sai antes de qualquer recusa (PROX-60). 61º relato no minuto → 429 com `Retry-After`, por conta; relato que não casa nunca conta como falha (61 sem par não bloqueiam a proximidade); relato contínuo a 1/s, com os tokens rodando a cada 20 s (o ritmo do app), nunca dá 429; sem a tela aberta → 409 `PROXIMITY_SCREEN_CLOSED`; proximidade bloqueada (20 falhas) → 429; criador → 403 (PERM-05); e-mail não confirmado → 403 | U/E | 4 |
| PROX-35 | **Redis fora no encostar** (fail-closed) | `touches` e pedido `ble` → 503 `PROXIMITY_UNAVAILABLE` com o Redis inteiro fora (PROX-21) e também com a falha só no relato (`recordTouch`), só no casamento (**`claimTouchPair`**, A2; o `markTouchPair` ficou só para o `/dev/simulate-request`), só na entrega do cartão devido (**`takeOwedCard`**: o cartão continua guardado para o relato seguinte) ou só na consulta do par (`hasTouchPair`); nada gravado (sem par, sem `prox:v`, sem `prox:c`); com o Redis de volta, segue (ver PROX-54). (A3-1, PROX-66) Com o `claimTouchPair` fora, também o relato **não mútuo** e o recusado pela política dão o mesmo 503 do mútuo (todo token válido de outra conta chega ao script) | U/E | 4 |
| PROX-36 | **Política no casamento** | bloqueio em qualquer sentido, conta excluída e criador: mesmo com as duas observações, nenhum dos lados recebe o cartão e o par não é gravado; a resposta é a de token inexistente. ~~Sem encosto mútuo, nem o banco é consultado~~ (revisto no A3-1, PROX-66): com token válido, do canal `ble` e de outra conta, o banco é consultado **sempre**, uma vez, e o script do casamento roda; sem encosto mútuo, ele volta `gone` | U/E | 4 |
| PROX-37 | **O que o `touches` revela** | sempre 200 `{items}`; o cartão traz só `token` (o `bleToken` relatado), `handle`, `name`, `avatarUrl`, `alreadyConnected` e (A2 rev. 1, R1-10) `pairExpiresInS`; nada de id, e-mail, `qrToken`, horário do encosto ou de quem relatou primeiro (o cartão na hora e o devido, até 4,999 s depois, trazem o mesmo `pairExpiresInS`, PROX-64); o primeiro relato é idêntico, byte a byte, ao de token inexistente; `Cache-Control: no-store`; o cartão não traz canário (PERM-10b) | E | 4 |
| PROX-38 | **Entrada do `touches`** | `strictObject {tokens: 1..1}` (A2-1: **exatamente 1 token**, `PROXIMITY_TOUCH_MAX_TOKENS` = 1; "uma pessoa por vez" vira regra do servidor): 0 ou 2 tokens (mesmo repetidos), 4 tokens, sem `tokens`, token mal formado, `tokens` que não é lista ou campo a mais (`rssi`, `txPower`, `model`, objeto no lugar do token) → 400 `VALIDATION_ERROR`, sem gravar nada; 1 token → 200, uma observação | U/E | 4 |
| PROX-39 | **Pedido `ble` exige o par** | sem o par (só o `bleToken`, mesmo com relato de um lado só) → 400 `PROXIMITY_TOKEN_INVALID` genérico, contado como falha, nada gravado; depois do encosto mútuo → 201 `ble`; com o par valendo, o `bleToken` "recente" (31 a 120 s) ainda serve; par vencido (60 s) → 400 genérico mesmo com o token recente; com o par A–B, o `bleToken` de C, o `qrToken` de B (canal trocado) ou o próprio `qrToken` → 400 genérico, contados como falha; o próprio `bleToken` → `CANNOT_CONNECT_SELF` | U/E | 4 |
| PROX-40 | **Pedido `qr` exige o `qrToken`** | `qrToken` válido de B, sem par → 201 `qr`; `bleToken` de B no pedido `qr` (mesmo com o par) → 400 genérico, contado como falha; `qrToken` com mais de 30 s → 400 | U/E | 4 |
| PROX-41 | **Aceite por método** | `ble`: sem `observedToken` → conectado; token enviado é ignorado e não conta falha; não depende do par (aceita com o par vencido, dentro dos 120 s do pedido); exige a tela aberta de B (409). `qr`: sem `observedToken` → 400 `VALIDATION_ERROR`, sem contar falha, e o pedido continua pendente; com o `qrToken` de A → conectado com `qr`; com o `bleToken` de A (canal trocado) ou o token de C → 400 genérico, contado como falha, pedido pendente; terceiro aceitando sem token → o 404 de inexistente (não descobre o método) | U/E | 4 |
| PROX-42 | **`/dev/simulate-touch`** (complementa o PROX-30) | com `NODE_ENV=production` ou `test` a rota não está registrada e responde o 404 de rota inexistente; em `development`, devolve só o `bleToken` da persona e grava a observação dela; o relato da conta com esse token dentro da janela dá o cartão pelo caminho real (política e par) e libera o pedido `ble`; fora da janela (5 s desde a simulação, A2) ou com bloqueio, nada; persona fora da lista ou campo a mais → 400; criador → 403. (A2-2 §7) A simulação apaga o cartão devido e o ocupado da persona (`forgetTouchState`): outra conta simula com a mesma persona logo depois e casa. O `simulate-request` no `ble` grava o par da persona e devolve o `qrToken` dela | U/E | 4 |
| PROX-43 | **Sem dado de sinal no servidor** | o `touches` leva só o token encostado, sem RSSI, potência nem modelo (o schema recusa, PROX-38, e o app não envia); as chaves do encosto têm só ids na chave. Valores (A2): `prox:o` = `"{primeiroMs}:{hash do token relatado por último}"`, vivo 10 s desde o último relato (A2 rev. 1); `prox:m` = horário (ms) ou, depois de um bloqueio entre os dois com o par vivo, `"{horário}:{a\|b\|ab\|ba}"` (os sentidos já contados no sinal, na ordem da contagem; o mesmo prazo, R1-6); `prox:v` = `"{hash}|{s, at, h, n, a, c}"` (id de quem deixou o cartão, horário do casamento, @, nome, chave da foto e `alreadyConnected`) antes da 1ª entrega e (A3-2, PROX-67) `"!{hash}|{s, at, h, n, a, c}"` depois, por até 10 s (`min(o que falta, 10 s)`), some junto com o `prox:c` dessa entrega; `prox:c` = `"1"`; os contadores `rl:prox-pairs:*` e `rl:prox-block-after-touch:*` só números. Nenhum token em claro nem dado de sinal | U/I/E/C | 4 |
| PROX-44 | **O campo TX declarado nunca muda o estado** (A1, regressão do veto ALTO) | o detector usa só a referência única `advertiserTxDbm` (0) e o RSSI medido, nunca um campo do anúncio: campo declarado -127, -100, -40, +20 ou ausente, com RSSI -85 ou -70 → nunca sai de `longe` em 5 s (nem `quase`, `encostando` ou `encostado`); RSSI forte de verdade (-30) chega a `encostado` depois do `holdMs` com qualquer campo ou sem ele; o anúncio forjado (RSSI -70, campo -100) nunca ganha o P8 de um encosto real; o rádio descarta um `txPower` que um nativo antigo mande (o avistamento vira exatamente `{token, rssi}`) e não descarta o anúncio. No aparelho: MAN-BLE-06, parte 1 | C (`touch-detector.test.ts`, `radio.test.ts`) + M | 4 |

**Adendo A2 da ADR 0012 (2026-10-30, decidido pelo PO): teto de pessoas novas e revelação simétrica garantida.** Os e2e ficam em `apps/api/test/e2e/proximity-touch.e2e-spec.ts` (rotas de verdade, política em SQL); o adaptador Valkey, em `real-services.e2e-spec.ts` (só no CI). Ficam só no unitário, por não terem caminho pela rota: o `gone` entre o relato e o casamento (a observação vencendo durante a consulta ao banco), o Valkey **lento** no sinal de abuso, a conta excluída antes do e-mail do sinal e o rótulo sem Redis na consulta (`findRecent` fora).

| ID | Cenário | Resultado esperado | Camada | Fase |
|---|---|---|---|---|
| PROX-45 | **Teto de pessoas novas** | com os padrões do PO (10/h e 30/dia): o 11º par novo da hora → `items: []` para os dois lados, sem par, sem cartão devido, sem somar em nenhum contador (nem do outro), sem falha de token e sem 429; renovação (encostar de novo com o par vivo) não conta; o teto vale para os dois (Ana no teto barra o par quando chama e quando é vista); a hora seguinte libera (janela fixa desde o 1º par novo); o 31º do dia continua barrado; o dia seguinte libera; o log `PROXIMITY_TOUCH_CAPPED` sai uma vez por tentativa barrada (os dois lados tentam), sem ids, @ nem tokens | U/E/I | 4 |
| PROX-46 | **Teto e ocupado sem oráculo** | `capped` e `busy` dão resposta idêntica, byte a byte (status, corpo, `Cache-Control`, `Content-Type`), à de não mútuo (PROX-37), para quem chama e para o outro; par recusado pela política (bloqueio nos dois sentidos, conta excluída) ~~nunca chega ao casamento~~ (A3-1, PROX-66) chega ao script do casamento e volta `refused`, sem gravar nada nem tocar os contadores. Os e2e veem o `gone` e o `refused` no registro `claims` do fake; o `gone` **entre** o relato e o casamento (a observação vencendo durante a consulta ao banco) só no unitário | U/E | 4 |
| PROX-47 | **Env do teto e da janela** | `PROX_TOUCH_PAIRS_PER_HOUR` 10 e `PROX_TOUCH_PAIRS_PER_DAY` 30 por padrão; vazio = padrão; 0, negativo, não inteiro ou `PER_DAY < PER_HOUR` → a API não sobe; `PROX_TOUCH_WINDOW_S` 5 por padrão, e `PROX_TOUCH_WINDOW_S + 2 > PROXIMITY_TOUCH_REPORT_FOR_S` (8) → a API não sobe | U | 4 |
| PROX-48 | **Janela do primeiro relato, com prazo deslizante** (reescrito na A2 rev. 1, R1-1) | cada relato regrava `prox:o` com `PX` de 2 × janela (10 s) **desde o último relato**, sem mudar o `primeiroMs` (sem `KEEPTTL`); com relatos a 1/s por 30 s (os tokens rodando aos 20 s), o `primeiroMs` continua o do 1º e o outro não casa depois dos 5 s; casa com 4,999 s, não com 5 s; 9,999 s sem relato → a chave vive, e o relato seguinte mantém o `primeiroMs`; 10 s sem relato → a chave some, e o relato seguinte abre outra janela (o outro casa nela com 4,999 s); valor no formato antigo = não existe (U e I); atraso honesto: V relata de 0 a 5 s, B só aos 6 s (não casa), o relato de V aos 7 s casa (V cria o par) e B recebe o cartão de V no relato seguinte | U/E/I | 4 |
| PROX-49 | **Revelação garantida: bloqueio depois** | V relata, M relata, recebe o cartão de V e bloqueia V (pela rota, eram conexões; e entre desconhecidos, pela rota, com o par vivo, PROX-61); o relato seguinte de V recebe o cartão de M (@, nome, foto assinada e `alreadyConnected` do casamento) com o token relatado; o pedido `ble` de V para M → 400 `PROXIMITY_TOKEN_INVALID`, nada gravado; ~~o relato depois desse → `[]` (entrega única)~~ (A3-2, PROX-67) os relatos até 10 s depois da 1ª entrega recebem o mesmo cartão (contando no limite, com o `pairExpiresInS` recalculado), e depois, `[]` | U/E/I | 4 |
| PROX-50 | **Revelação garantida: exclusão e logout** | M sai (logout revoga os tokens): V relata o token revogado e recebe o cartão de M; M muda o nome e exclui a conta depois do casamento: V recebe o cartão do casamento (nome de antes, não lido do banco); o pedido com esses tokens → 400; sem relato por 60 s, o cartão some (59,999 s ainda guardado) | U/E | 4 |
| PROX-51 | **Rótulo do cartão devido** | `token` = o `t` relatado quando o hash bate com o guardado ou `t` é (válido ou recente) do dono do cartão (token rodado: o pedido com ele vale); `t` de outra pessoa (P, com quem V tem par vivo), revogado sem o hash guardado ou inexistente → um token de 16 caracteres nunca emitido nem gravado, e o pedido com ele dá o 400 genérico sem chegar a ninguém (controle: com o token de P, o pedido chegaria a P); sem o Redis na consulta do rótulo, o cartão sai com o token nunca emitido (só U). App: o "Conectar" desse cartão cai no estado 17 sem parar a tela | U/E/C | 4 |
| PROX-52 | **Atacante sem janela (variantes A e B no servidor)** (reescrito na A2 rev. 1, R1-2) | (A) V relata tM a cada 1 s de 0 a 12 s, com tM2 (outro token de M) de 3 a 8 s; M relata tV só depois do último relato de V, aos 13, 15 e 21,9 s → nunca casa, sem par e sem cartão devido, e a chave de V sobre M ainda vive aos 21,9 s com o `primeiroMs` de 0 s (com o `KEEPTTL` antigo, o de 13 s casaria). À parte: com M relatando enquanto V ainda relata (aos 9,9 s), o relato de V aos 10 s casa pelo atraso honesto, V vê M na hora e M recebe o cartão de V no relato seguinte (revelação simétrica, não ataque); (B) V relata tM em 0, tX de 1 a 8 s, tY de 9 a 14 s e tM de novo aos 15 s → a chave de V sobre M vive com 9,999 s, some aos 10 s e volta aos 15 (janela de 15 a 20); M relata aos 16 s → `created`, e o relato de V aos 17 s recebe o cartão de M; M casa e passa a anunciar o token de outra conta sua (P) → V recebe o cartão de M, com um token que não serve para pedir (PROX-51) | U/E | 4 |
| PROX-53 | **Uma pessoa por vez (ocupado)** | com um cartão devido a V (inclusive o já entregue, à espera da reentrega, A3-2), ou até 10 s depois de V receber um, nenhuma outra conta casa com V (`busy`), quando ela chama e quando V chama (A3-2: V chamando enquanto vale a reentrega recebe de novo o cartão de M; o `busy` de V chamando aparece quando o cartão chegou com menos de 10 s de vida e venceu antes do ocupado, PROX-67); quem cria o par também fica ocupado 10 s; a resposta de quem tenta é a de não mútuo, byte a byte; V recebe o cartão de M, nunca o de quem tentou; o cartão devido nunca é sobrescrito; passado o ocupado, casa | U/E/I | 4 |
| PROX-54 | **Atomicidade e Valkey fora** | falha só no `claimTouchPair` ou só no `takeOwedCard` → 503 `PROXIMITY_UNAVAILABLE` e nada gravado (o cartão devido continua guardado); dois relatos simultâneos do mesmo par (HTTP em paralelo, e 50 rodadas no Valkey) → um `created`; ~~cada lado vê o outro exatamente uma vez~~ (A3-2) cada lado recebe o cartão do outro na mesma chamada ou na seguinte (quem criou, só na própria; o outro, se recebeu na própria, recebe a reentrega na seguinte); nunca dois pares nem dois cartões devidos; cada conta soma 1 | U/E/I | 4 |
| PROX-55 | **Sinal de abuso** | bloqueio gravado com o par vivo (≤ 60 s) soma para quem bloqueou e para quem foi bloqueado, uma vez por casamento e por sentido (PROX-63); no 3º em 7 dias, um e-mail para a moderação por papel (A2 rev. 1, R1-6: "fez 3 bloqueios" / "recebeu 3 bloqueios", com a coluna `blocker_id` ou `blocked_id` para conferir, nunca "3 pessoas"), com o @ da conta e sem o @ nem o id da outra parte; o 4º não repete; depois de 60 s não soma (mas o bloqueio é gravado); bloqueio sem par e sem ver o perfil não grava e não soma; entre desconhecidos com o par vivo, grava e soma (PROX-61); Valkey fora no sinal (`countBlockSignal`) → o bloqueio responde 204, é gravado e nada soma; a transação do bloqueio falhou → sem sinal. Só U: Valkey lento (> 500 ms), conta excluída → sem e-mail, o envio falhando fica no log | U/E | 4 |
| PROX-56 | **Adaptador Valkey** | os quatro scripts contra o Valkey real, com os mesmos casos do fake: `TOUCH_SCRIPT` (`"{primeiroMs}:{hash}"`, A2 rev. 1: `PX` de 2 × janela em **todo** relato, sem `KEEPTTL`, mantendo o `primeiroMs` e trocando o hash; prazo quase no fim → renovado; prazo maior → volta a 10 s; chave vencida → o relato seguinte abre outra janela; 4,999/5 s, formato antigo), `BLOCK_SIGNAL_SCRIPT` (A2 rev. 1, R1-6: sem par → `null` sem gravar nada; marca o sentido no par com `KEEPTTL` e soma 1 nos dois contadores, com `PEXPIRE` de 7 dias; o mesmo sentido não conta de novo; o outro conta uma vez, "ab" ou "ba"; a renovação do par limpa as marcas; contador sem prazo ganha o `PEXPIRE`; valor ilegível → `null`; 5 contagens simultâneas → uma só), `CLAIM_TOUCH_SCRIPT` (`gone`, `created` com o par, o cartão devido, o ocupado e os quatro contadores com PEXPIRE de 1 h e 24 h, `busy` nos quatro sentidos sem gravar, `renewed` sem somar, `capped` pela hora e pelo dia sem gravar; (A3-1, PROX-66) com o cartão nulo, `gone` antes e `refused` logo depois, antes do ocupado e do teto, sem gravar nada) e `TAKE_OWED_CARD_SCRIPT` (~~entrega única, ocupado com PX, ilegível apagado~~ (A3-2, PROX-67) sem `DEL`: a 1ª retirada marca `"!"` com `PX` de `min(o que falta, 10 s)` e grava o ocupado; a reentrega devolve o mesmo cartão sem mexer no prazo nem no ocupado; o cartão com menos de 10 s não ganha prazo; ilegível → `null`, marcado e não apagado; o cartão marcado ocupa sozinho no `CLAIM_TOUCH_SCRIPT`); 50 rodadas de casamentos simultâneos → um `created` e um `busy` (`real-services`, só no CI) | I | 4 |
| PROX-57 | **App: token novo e prazo que só cresce** (reescrito na A2 rev. 1, R1-3) | `reportForMs` = `PROXIMITY_TOUCH_REPORT_FOR_S` × 1000 e cobre `(PROXIMITY_TOUCH_WINDOW_S + 2) × 1000`; o relato vai até 8 s depois do mais tardio entre o encosto admitido e a resposta de cada relato de token novo; token novo = nunca aceito no período do Pronto, ou último relato aceito começou há ≥ 5 s na hora da resposta; (A) tM encostado em 0 e de novo em 3 s (aceito há 1 s, não é novo) → prazo até 11 s, relatos a 1/s até lá; tM2 em 3 s → novo, prazo = resposta + 8 s; (B) tM em 0, tX em 1 s, tY em 9 s e tM de novo em 15 s → tM conta como novo em 15 s, e o app relata até a resposta + 8 s (≥ 23 s); o prazo nunca desce; o 409 não conta como aceito; voltar ao Pronto zera o mapa (só estende); o aviso ~~dos 4 s~~ não muda com o token novo (A3-3: passa a 7 s, PROX-70); P8: o token de menor perda, se não for novo ou se passar pelo portão | U (app, `useTouch.test.tsx`) | 4 |

**Adendo A2, revisão 1 (2026-10-30): prazo deslizante, um relato por vez, bloquear e denunciar pelo cartão.** Os e2e do servidor ficam em `proximity-touch.e2e-spec.ts` (PROX-48, 52, 55, 60 e 64) e em `proximity-card-actions.e2e-spec.ts` (PROX-61, 62 e 63, e o PROX-65 da R1-PO-1); o adaptador Valkey, em `real-services.e2e-spec.ts` (PROX-56, só no CI). Os do app ficam em `useTouch.test.tsx` (PROX-57, 58, 59 e 64), `connect-moderation.test.tsx` e `TouchCard.test.tsx` (PROX-61 e 62, com o item M da `ux.md` §11.14 no nome).

| ID | Cenário | Resultado esperado | Camada | Fase |
|---|---|---|---|---|
| PROX-58 | **App: um relato por vez (variante C)** | 5 tokens novos encostados em 300 ms → um relato em voo, com inícios espaçados ≥ 1 s (`reportEveryMs`); com a resposta levando 2 s, nunca dois em voo; a troca de sessão, sair e voltar ao Pronto e desmontar e montar a tela não furam o ritmo (estado no módulo; `resetTouchReportGate()` entre os testes); a resposta que chega depois de sair do Pronto libera o próximo relato | U (app, `useTouch.test.tsx`) | 4 |
| PROX-59 | **App: orçamento contra transmissor girando UUIDs (BAIXO 5)** | `reportBudgetPerMinute` 40 ≤ 2/3 de `PROXIMITY_TOUCH_LIMIT_PER_MIN`; `reportReserve` 10 ≥ `ceil(reportForMs / reportEveryMs) + 1`; um UUID novo encostado a cada 200 ms por 3 min, todos com 200 `[]` → nunca mais de 39 inícios em qualquer janela de 60 s, e nenhum 429; cada token novo e cada encosto admitidos o foram com ≤ 30 inícios nos 60 s anteriores; acima disso, o token novo é ignorado e o relato segue com o último token aceito até o fim do prazo aberto (o prazo nunca encurta: há relato depois de resposta + 7 s do último admitido); o mesmo token sumindo e voltando a cada 3 s também passa pelo portão; encosto recusado não abre a sessão nem muda a fase, e o QR em destaque aparece aos 20 s sem encosto admitido; o portão reabre quando os inícios antigos saem dos 60 s; um encosto real, mais forte, é o admitido quando o portão abre. (A3-3, medido em 2026-10-31) Com a repetição depois de falhas, o pior caso por admissão sobe de 39 para 51 inícios em 60 s (o A3 estimou 52) e, com a rede alternando numa admissão só, para 56: abaixo dos 60 do servidor e sem 429 (PROX-68) | U (app, `useTouch.test.tsx`) | 4 |
| PROX-60 | **Cartão devido antes de qualquer recusa (R1-4)** | com um cartão devido a V: o 61º relato no minuto → 200 com o cartão (não 429), e a entrega não soma no limite (com 59 relatos antes, o relato depois do cartão é o 60º, 200, e só o seguinte dá 429); com a proximidade de V bloqueada (20 falhas) → 200 com o cartão; sem `prox:u` (a tela fechou aos 30 s) → 200 com o cartão (`pairExpiresInS` 25); sem cartão devido, os mesmos casos dão 429, 429 e 409, como hoje; Valkey fora no `takeOwedCard` → 503 (e não o 429 do bloqueio), e o cartão continua guardado para o relato seguinte, sem a marca de entregue. (A3-2, PROX-67) Vale para a **1ª entrega**; a reentrega passa só pelo limite: com a proximidade bloqueada ou a tela fechada, sai (200); acima do limite, 429 com o `Retry-After` do limite (não o do bloqueio), sem mexer no cartão | U/E | 4 |
| PROX-61 | **Bloquear pelo cartão (opção (a) do PO, R1-5)** | V e M desconhecidos com par vivo: `POST /me/blocks {handle: M}` → 204, gravado, e o pedido pendente do par cancelado; o mesmo de V para M, também quando M já bloqueou V; o bloqueado aparece no `GET /me/blocks` de quem bloqueou (só @ e data); sem par (sem encosto, ou 60 s depois do casamento; com 59,999 s ainda grava) → o mesmo 204 sem gravar, como o A-05; conta excluída com par vivo → 204 sem gravar; o próprio @ → 400; criador visível → bloqueado como hoje (204, gravado, sem consultar o Valkey: passa com o `hasTouchPair` derrubado); criador que a pessoa não vê (ele a bloqueou), mesmo com um par → 204 sem gravar (a regra do par só vale entre contas pessoais); Valkey fora (`failing`) ou lento (`stalling`, 500 ms) com alvo não visível → 503 `PROXIMITY_UNAVAILABLE`, com a mesma resposta (status, corpo e cabeçalhos) para @ existente com e sem par, inexistente, excluído e inválido, nada gravado; alvo visível (conexão) com o Valkey inteiro fora → 204 gravado; o pedido `ble` de V para M depois do bloqueio → 400 genérico. App: os botões no cartão (`connect-moderation.test.tsx`, `TouchCard.test.tsx`) | U/E + U (app) | 4 |
| PROX-62 | **Denunciar pelo cartão (R1-5)** | com par vivo: `POST /reports {target: {type: 'account', handle: M}}` → 202, denúncia gravada (`target_user_id` = M) e e-mail para a moderação (sem o @ de quem denunciou), também quando M bloqueou V; sem par (sem encosto, ou 60 s depois; com 59,999 s ainda vale) → o 404 idêntico ao de @ inexistente (X.1 CA1), nada gravado nem enviado, salvo se V bloqueou M (revisto em 2026-10-31: aí vale o PROX-65, 202 sem prazo); conta excluída com par → 404; Valkey fora ou lento com alvo não visível → o mesmo 503 do PROX-61 (@ com e sem par, inexistente, excluído e inválido), nada gravado nem enviado, salvo a conta que V bloqueou (PROX-65: 202, sem consultar o Valkey); alvo visível (conexão) com o Valkey fora → 202; denunciar e depois bloquear, e bloquear e depois denunciar, dentro dos 60 s e nos dois sentidos → tudo passa; o par não é consumido (`hasTouchPair` continua verdadeiro); post e comentário de M seguem a regra de sempre (404 com o par). App: o formulário aberto pelo cartão 11, 14 ou 22 (A3-4), com o T46; (revisto em 2026-10-31, R1-PO-1, como o `frontend` implementou e a `ux.md` §11.14 registrou) o aberto pelo Bloqueado vem **sem** o T46, e o Bloqueado **não vence**: depois do fim do par (60 s), continua na tela com o ‹Denunciar›, sem o T20 e sem manter a tela acesa; o formulário aberto por ele vale além do fim do par; o 202 (M9) e o "Cancelar" (M12), antes ou depois do prazo, voltam **ao Bloqueado** (só o ‹Denunciar›, o foco no nome; o Toast do 202 depois do foco; o "Cancelar" sem Toast nem T20); só o 404, que no Bloqueado vem só da conta excluída (M10), leva ao Pronto, com o `PROFILE_GONE_MESSAGE` e sem o T20; "Voltar" (M13) → Pronto, sem Toast, com o foco no título (`connect-moderation.test.tsx`, com o PROX-65 no nome) | U/E + U (app) | 4 |
| PROX-63 | **Sinal uma vez por casamento e por sentido (BAIXO 3, R1-6)** | com o par vivo: 5 bloqueios simultâneos de V para M (HTTP em paralelo) → uma linha e +1 só, em `blocker:V` e `blocked:M`; bloquear, desbloquear e bloquear de novo (pelo @ e pelo `commentId`) → nada a mais; M também bloqueia V → +1 em `blocker:M` e em `blocked:V`; `prox:m` = `"{horário}:{a\|b\|ab\|ba}"` (conjunto de sentidos, na ordem da contagem), com o mesmo prazo (`KEEPTTL`: 60 s desde o casamento), e o `hasTouchPair` continua verdadeiro; casamento novo (renovação, depois de desbloquear) → o par volta a `"{horário}"` e conta de novo; uma conta sozinha não leva M a 3 sem 3 casamentos (bloquear e desbloquear 4 vezes no mesmo casamento soma 1); 3 contas diferentes bloqueando M → um e-mail com o texto da R1-6 ("recebeu 3 bloqueios", a frase de "no máximo um bloqueio em cada sentido", a coluna `blocked_id`, nunca "3 pessoas"), com o @ de M e sem o @ nem o id das outras | U/E/I | 4 |
| PROX-64 | **`pairExpiresInS` (R1-10)** | os dois caminhos (e a reentrega, A3-2) usam `5 × floor(max(0, at + TTL − agora − 1) / 5000)`, limitado a ~~[0, TTL]~~ (A3-5) [0, TTL − 5] (nunca acima de 55, mesmo com o horário do casamento no futuro: a instância que entrega com o relógio atrás da que casou, 1 ms, 3 s ou 9,999 s → 55, nunca 60), contado do casamento: 55 no casamento na hora e no cartão devido entregue até 4,999 s depois (os dois lados recebem o mesmo valor, PROX-37); 50 de 5 a 9,999 s; 25 com 30 s; 5 com 54,999 s; 0 de 55 s até 59,999 s (nunca negativo); a renovação volta a 55 nos dois lados. App: `expiresAt` = chegada + `min(cardTtlMs, pairExpiresInS × 1000)` (55 s no casamento na hora; o que sobra no cartão devido que chega tarde), e os botões do cartão seguem esse prazo | U/E + U (app, `useTouch.test.tsx`) | 4 |
| PROX-65 | **Denunciar a conta de quem você bloqueou (R1-PO-1, aprovada pelo PO em 2026-10-30; caso de 2026-10-31)** | V bloqueou M (pela conexão, pelo par ou, entre criadores e fãs, pelo `commentId`) e, sem par (60 s depois do encosto, ou sem encosto), denuncia M: `POST /reports {target: {type: 'account', handle: M}}` → 202 sem corpo, linha com `target_user_id` = M e e-mail para a moderação sem o @ nem o id de V, **sem consultar o Valkey** (`hasTouchPair` não é chamado); com o Valkey fora (`failing` ou `down`) ou lento (`stalling`) → o mesmo 202, sem 503 (na mesma hora, o desconhecido dá o 503 de sempre); repetir → 202 idempotente (uma linha e um e-mail); bloqueio nos dois sentidos → os dois denunciam (202). Só nesse sentido: só M bloqueou V, sem par → o 404 idêntico (status, corpo e cabeçalhos) ao de @ inexistente, com as mesmas consultas de um desconhecido (`hasBlocked` de V para M e o par), e com o Valkey fora ou lento → o 503 idêntico ao de @ inexistente, excluído e inválido, nada gravado nem enviado. Depois do desbloqueio, sem par → o 404 de inexistente de novo (a denúncia anterior não abre a porta). M excluiu a conta (a linha em `blocks` fica) → o 404 de inexistente (503 com o Valkey fora). Post e comentário de M → o 404 de inexistente, como sempre. Regressão do bloqueio: `POST /me/blocks {handle: M}` de novo não ganha a regra (Valkey fora ou lento → 503 igual ao de @ inexistente; sem par → o 204 do A-05, consultando o Valkey, sem linha nova). App (2026-10-31): o Bloqueado do Conectar sem prazo e o formulário dele sem o T46, como descrito no PROX-62 | U/E (`access-policy.service.spec.ts`, `reports.service.spec.ts`, `proximity-card-actions.e2e-spec.ts`) + U (app, `connect-moderation.test.tsx`) | 4 |

**Adendo A3 da ADR 0012 (2026-10-31): tempo igual no `touches`, reentrega do cartão e cartão atrasado.** Os e2e do servidor ficam no fim de `proximity-touch.e2e-spec.ts` (PROX-66 e 67, e o teto do PROX-64); o adaptador Valkey, em `real-services.e2e-spec.ts` (PROX-56, 66 e 67, só no CI). O fake de teste (`TestProximityStore`) registra, na ordem, cada ida ao Valkey e as consultas do repositório (`calls`, que o `createTestApp` anota): desde a correção do BAIXO 1 do `seguranca` (A3-8 item 2, 2026-10-31), o `findTouchPair` do `touches`, e o `findNearby` do `resolve`, que fica anotado para uma volta acidental dele ao `touches` aparecer na sequência. Registra também todo resultado do script do casamento, inclusive `gone` e `refused` (`claims`). O `findTouchPair` tem e2e próprio contra o banco do teste (último bloco de `proximity-touch.e2e-spec.ts`), e a regressão do `resolve` fica em `proximity.e2e-spec.ts`. Os do app (PROX-68 a 70), conferidos pelo `testes` em 2026-10-31 depois das duas etapas do `frontend` (o motor e a tela), ficam em `client.test.ts`, `hooks.test.tsx`, `helpers.test.ts`, `useTouch.test.tsx`, `connect.test.tsx`, `connect-card-arrival.test.tsx`, `connect-card-queue.test.tsx` (acrescentado em 2026-10-31, depois das correções da `ux.md` §11.17 e do teto das emissões, com mutação: 10 mutantes, todos mortos), `connect-session-end.test.tsx` (acrescentado em 2026-10-31, PROX-69: o último cartão é da conta), `connect-moderation.test.tsx` e `TouchCard.test.tsx`, e o `titleRef` do `EmptyState` no `packages/ui` (`EmptyState.test.tsx`); os IDs deixaram de ser provisórios. O que só o aparelho mostra (o `onDismiss` da câmera no iOS, o fechamento dela no Android, o foco e os anúncios com VoiceOver e TalkBack, e a rede de verdade) está no MAN-QR-01, no MAN-BLE-03 e no MAN-A11Y-01 (§8), ainda sem execução.

| ID | Cenário | Resultado esperado | Camada | Fase |
|---|---|---|---|---|
| PROX-66 | **`touches`: o mesmo caminho para todo token válido (R22, A3-1)** | Com token válido, do canal `ble` e de outra conta, e sem cartão devido: não mútuo (`gone`), recusado pela política (V bloqueou O, O bloqueou V, O excluiu a conta depois de relatar: `refused`), `capped`, `busy` e casamento (`created` e `renewed`) fazem as mesmas idas, na mesma ordem: `takeOwedCard`, `lockRemainingMs`, `hit`, `isScreenOpen`, `findValid`, `recordTouch`, `findTouchPair` e `claimTouchPair`, com o `findTouchPair` e o `claimTouchPair` uma vez cada e nunca o `findNearby` (revisto em 2026-10-31, BAIXO 1 do `seguranca`, A3-8 item 2: a política do `touches` saiu do `findNearby`); os recusados, o teto e o ocupado dão o corpo do não mútuo, byte a byte (PROX-46). Token inexistente, do QR, próprio, vencido ou revogado para no `findValid` (as 5 primeiras idas), sem observação nem resultado do script. `claimTouchPair` com o cartão nulo → `refused` logo depois do `gone` (sem a observação ou fora da janela, `gone`) e antes do ocupado e do teto, sem ler nem gravar par, contadores, cartão devido ou ocupado (fake, texto do Lua sem `redis.call` entre os dois e Valkey real). Falha: `claimTouchPair` fora → o mesmo 503 no não mútuo, no recusado e no mútuo (PROX-35); Postgres fora (`findTouchPair`) → o mesmo 500 no não mútuo e no mútuo. **`findTouchPair` (BAIXO 1)**, contra o banco do teste: o `WHERE` filtra só pelos ids, então voltam **2 linhas** sempre que as duas contas existem, com `personal`, `active`, `connected` e `blocked` em colunas, como `boolean` de JS, e `connected` e `blocked` iguais nas duas linhas: sem relação (com conexões e bloqueios de cada uma com terceiras, em cada sentido e de cada lado do par ordenado, que não contam), conexão (`connected`, com os ids nas duas ordens, pelo `least`/`greatest`), V bloqueou O, O bloqueou V e os dois sentidos (`blocked`; desbloqueado pela rota, `false` de novo, nos dois sentidos só depois do segundo desbloqueio), O excluída (`active = false` só na linha de O), O criadora (`personal = false` só na linha de O), O excluída e bloqueada; O apagada de vez → 1 linha. No `EXPLAIN ANALYZE` do SQL que ele manda, a conexão e os dois sentidos do bloqueio rodam uma vez cada, com e sem bloqueio (nenhum `never executed`), e o plano sem os ids e as contagens é o mesmo nos quatro casos. Pela rota, a recusa sai das colunas: V bloqueou O, O bloqueou V, os dois sentidos, O excluiu a conta, O criadora (token só no fake: a rota não emite token para criador) e O apagada de vez, com as duas observações → as linhas que o banco devolveu são as esperadas, `refused`, as idas de sempre e o corpo do não mútuo, byte a byte, sem o @ nem o nome de ninguém. O `resolve` (QR) continua no `findNearby`, com o filtro da política no `WHERE` (dos cinco donos enviados, só a conta livre volta; sem o `findTouchPair`). Mutação: devolver o `if (!inWindow) return`, o `if (owner === undefined …) return`, pular o script na recusa ou a consulta fora da janela derruba o caso; no SQL do `findTouchPair`, trocar `blocker_id`/`blocked_id` num sentido, tirar um dos `exists` ou uma das condições de um deles, inverter ou tirar o `least`/`greatest` e voltar o filtro de conta excluída ao `WHERE` derrubam os testes de comportamento; o `or` no lugar da soma só o teste do plano derruba (o segundo sentido fica `never executed` quando o primeiro acha o bloqueio); em `touchRevealParties`, tirar `owner === undefined`, `!owner.personal`, `!owner.active` ou `owner.blocked` derruba o e2e e o unitário, e `caller === undefined`, `owner.id === caller.id`, `!caller.personal` e `!caller.active` só o unitário (pela rota, quem chama passa pelos guards, e o próprio token para no `findValid`) | U/E/I | 4 |
| PROX-67 | **Reentrega do cartão devido (R23, A3-2)** | A 1ª retirada devolve o cartão (`redelivered: false`), não o apaga: grava `"!{hash}\|{json}"` com prazo `min(o que falta, 10 s)` e o ocupado por 10 s (PROX-43). A resposta se perde: o relato seguinte, em menos de 10 s, recebe o mesmo cartão (`redelivered: true`), com o rótulo e o `pairExpiresInS` recalculados (55 → 50 → 45 do horário do casamento), só com `takeOwedCard` e `hit` (sem bloqueio, tela, política, observação nem casamento), sem regravar o valor, o prazo nem o ocupado. **Rótulo da reentrega (BAIXO 2 do `seguranca`, A3-8 item 3, 2026-10-31):** é `t` só quando o hash de `t` é o guardado no casamento; senão, um token nunca emitido, **sem** o `findRecent` (as idas continuam só `takeOwedCard` e `hit`). O dono girou o token entre a 1ª entrega (perdida) e a reentrega, e quem chama relata o token novo (que é do dono: na 1ª entrega ele seria o rótulo, PROX-51) → o cartão chega com um token nunca emitido, diferente a cada reentrega, e o pedido `ble` com ele → 400 `PROXIMITY_TOKEN_INVALID`, nada gravado; o token de outra pessoa com par vivo e um inexistente, o mesmo; o token do casamento → o próprio token, e o pedido com ele → 201. A 1ª entrega não mudou (`findRecent` para o token girado ou recente do dono); aos 10 s, acabou, e a pessoa casa com outra na hora (o ocupado não foi esticado). Limite: a 1ª entrega não conta (sai com o limite estourado, a tela fechada e a proximidade bloqueada, tudo junto); a reentrega conta: acima do limite, 429 com o `Retry-After` do limite (6 s; 29 s), não o do bloqueio, e o cartão segue; com o limite renovado, ainda nos 10 s, o mesmo cartão sai. O cartão com menos de 10 s de vida não ganha prazo (vence com o par), e o ocupado dura os 10 s (a pessoa chamando → `busy`, igual a não mútuo). O cartão marcado ocupa a conta sozinho no casamento, mesmo sem o `prox:c`. Valor ilegível → `null`, sem `DEL` (marcado, vence em até 10 s). Valkey fora no `takeOwedCard` → 503, e o cartão continua sem a marca. Mutação: a reentrega sem o `consume`, com todas as recusas, regravando o ocupado ou o prazo; apagar em vez de marcar; a 1ª entrega sem encurtar o prazo; no rótulo (BAIXO 2), a reentrega sem o atalho (de volta ao `findRecent`), o atalho invertido e o atalho antes da conferência do hash derrubam o unitário e o e2e | U/E/I | 4 |
| PROX-68 | **App: falha de rede no relato (R23, A3-3 itens 1 a 4 e 7)** | **Prazo** (`ApiClient.request` com `timeoutMs`; só o `reportTouch` usa, com `reportTimeoutMs` 4000): sem resposta em 4 s, o `AbortController` aborta o `signal` do `fetch` e a chamada falha com `NetworkError`, também com um `fetch` que ignora o `signal` (a corrida com o prazo); a resposta antes do prazo não deixa relógio pendente; sem `timeoutMs`, nenhum `signal` vai ao `fetch`; o prazo que acaba durante o refresh do 401 → `NetworkError`, sem repetir a chamada, e o refresh termina para as outras. **Falha repetível** (`isRepeatableFailure`): `NetworkError` (inclusive o prazo) e 5xx; 429, 403, 400, 409, 404 e resposta fora do contrato, não. **Sequência de falhas** (`useTouch.ts`): sem rede, 503 e o prazo não param a tela; o relator repete o token do relato que falhou, um por vez, a cada 2 s (`reportRetryEveryMs`, ≥ `reportEveryMs`), sem a escolha do P8 e sem o portão (o encosto mais forte no meio dela espera), enquanto `agora < max(prazo, início do 1º relato que falhou + 10 s)` (`cardRedeliveryMs` = 2 × janela): sem rede e 503 → inícios aos 0, 2, 4, 6 e 8 s e a tela parada aos 10 s; o prazo de 4 s → 0, 4 e 8 s, parada aos 12 s; a tela para com o **último** erro (503 quatro vezes e depois sem rede → `NetworkError`); qualquer 200 (com ou sem cartão, inclusive a reentrega ignorada) encerra a sequência, e voltam o ritmo de 1 s e o P8; 429, 403 e 400 param na hora, sem repetir; o 409 cuja renovação falha por rede ou 503 entra na sequência (com 429 na renovação, para); sair do Pronto com a sequência aberta → nada mais é relatado, e a tela não para. **Na tela:** os estados 18 (sem rede) e 19 (503) só no fim da sequência, nunca antes dos 10 s; a resposta com o cartão perdida (sem rede, 503 ou o prazo) → o mesmo token sai de novo, a reentrega abre o 11 com o Conectar, e a tela não para (o diagrama do A3). **Renovação dos tokens** (`hooks.ts`): a falha repetível na renovação tenta de novo a cada 3 s (`tokenRetryMs`), até 3 vezes (`tokenRetries`), com os tokens de antes valendo, e só então para a tela; as 3 cabem entre a renovação (20 s) e o fim da validade (30 s); a renovação que volta segue o ciclo de 20 s, e a falha seguinte ganha as 3 tentativas de novo; o 429 na renovação e qualquer erro no 1º pedido da visita param na hora. **Teto das emissões** (`hooks.ts`, acrescentado em 2026-10-31): sem ele, as tentativas zeradas a cada sucesso fariam até 9 emissões em 60 s numa rede ruim, e a 7ª levaria o 429 do servidor (estado 20, o motivo errado). O app conta cada emissão (o 1º pedido, a renovação, a tentativa de novo e o `refresh` do 409), também a que falhou, numa janela móvel de 60 s (`tokenIssueWindowMs`), e a tentativa de novo que seria a 7ª (`tokenIssueLimit` 6, o `prox-tokens:user` da API) não sai: a tela para com o último erro repetível (18 sem rede, 19 com 503), nunca com o 429. A janela fixa do servidor (INCR + PEXPIRE) nunca conta mais que a móvel. Casos, num servidor falso com o limite: [certo, falha ×3, certo, falha] → 6 emissões e a parada aos 52 s, sem o 7º pedido e sem 429 (sem rede e 503); com 2 `refresh` no início, a 2ª tentativa já não sai (29 s); a janela vale entre visitas (segundo plano aos 24 s e volta aos 25 s: o 1º pedido da visita nova sai e conta, e a tentativa dos 51 s não sai); a renovação que volta na 2ª tentativa e a falha seguinte, com a janela livre, ganham as 3 tentativas; a renovação normal (5 min, 16 emissões) e o 1º pedido da visita nunca são barrados. Fora do teto (ressalva 🟢 de 2026-10-31, para o Tech Lead): sair da aba desmonta a sessão e zera a contagem, e o "Tentar de novo" logo depois da parada pelo teto é o 1º pedido de uma visita; nos dois casos, o servidor ainda pode responder 429. **Orçamento** (PROX-59): o A3 estimou 52 inícios por admissão; medido no app, 51 (30 antes, a admissão, o prazo, 4 da sequência e o 200 que a encerra estendendo o prazo uma vez) e, com a rede alternando (7 respostas e 2 falhas por ciclo, 3 min numa admissão só: cada 200 depois de ≥ 5 s sem aceite estende o prazo de novo), 56 em 60 s. Aceito pelo Tech Lead em 2026-10-31: o teste garante menos de 60 em qualquer janela de 60 s e nenhum 429 | U (app: `client.test.ts`, `helpers.test.ts`, `useTouch.test.tsx`, `hooks.test.tsx`, `connect.test.tsx`) | 4 |
| PROX-69 | **App: reentrega e cartão fora do Pronto (R23, A3-3 itens 5 e 6; `ux.md` §11.15)** | **Reentrega** (`lastCard` no módulo, junto do `touchReportGate`): o cartão com o @ do último cartão mostrado há menos de 10 s (`cardRedeliveryMs`) é ignorado: não abre cartão, não conta como aceito, não estende o prazo e não para o relator (o aviso dos 7 s sai e o relato vai até o prazo do encosto); só encerra a sequência de falhas (volta o ritmo de 1 s); vale também para o cartão mostrado por outra instância do motor (desmontar e montar); aos 10 s exatos, aparece; o cartão que a tela descarta (`onCard` → `false`) não conta como mostrado; na tela, fechar o cartão e encostar de novo em menos de 10 s deixa a tela no Pronto. **O último cartão é da conta** (BAIXO da 2ª passada do `seguranca`, 2026-10-31): o `lastCard` guarda o `ownerId`, e a reentrega só é ignorada para a mesma conta (o motor de outra conta recebe o mesmo @ em menos de 10 s e ele aparece, mesmo sem a limpeza). A limpeza é o `useTouchSessionScope(userId)`, chamado no `RootNavigator`: quando o `userId` muda, o `lastCard` é esquecido no fim do efeito da conta anterior. Isso vale para sair, sair de todos, excluir a conta, redefinir a senha, refresh recusado, 401 na abertura e troca de conta, porque todos levam o `userId` a `null` ou a outro `id`; os testes passam por sair, pelo refresh recusado e pela troca direta no hook. O ritmo e o orçamento do portão (`starts`, `lastStartAt` e `inFlight`) **não** são zerados (R1-3 item 2, PROX-58). No hook, a conta A sai e a B entra logo depois de um relato de A: com ele em voo (resposta em 1,8 s), o 1º relato de B sai na resposta, aos 1,8 s do de A, nunca dois em voo; com ele já respondido, sai 1 s depois do início dele; com mais de 30 inícios de A nos últimos 60 s, o encosto de B é recusado (nenhum relato, a fase não muda, PROX-59) e entra quando os inícios de A saem dos 60 s. No hook (`useTouch.test.tsx`), com o cartão mostrado à conta A e o mesmo @ reentregue aos 2 s: a mesma conta, sem sair → ignorado até os 9,9 s; saiu (`null`) e entrou de novo A, saiu e entrou B, trocou direto para B → aparece. No app inteiro (`connect-session-end.test.tsx`), com o cartão de Caio fechado e o mesmo @ reentregue, tudo antes dos 10 s do cartão: sem sair (Perfil e de volta ao Conectar) → continua ignorado; "Sair da conta" e entrou outra conta → aparece; "Sair da conta" e entrou de novo a mesma → aparece; sessão expirada (refresh recusado) e outra conta → aparece. Em todos, o relato depois da volta ao Conectar sai e traz o cartão (o "continua ignorado" não passa com um app que não relata). Mutação (do `frontend`, 2026-10-31): sem a limpeza, 2 testes caem; sem a comparação do `ownerId`, 1; sem as duas, 7; sem a chamada no `RootNavigator`, 1. Mutação (do `testes`, 2026-10-31): a limpeza zerando o portão inteiro (`resetTouchReportGate()`) derruba os 3 testes do ritmo e do orçamento; zerando só o `inFlight`, só o `lastStartAt` ou só os `starts`, cai 1 em cada caso (o do campo); o motor que deixa de relatar com um cartão na memória sobrevivia ao "continua ignorado" antes da conferência do relato e agora cai. **Fora do Pronto** (`useTouch.ts` e `placeCard`): o cartão de um relato em voo vai para a tela depois de sair do Pronto e em outro período do Pronto, e não depois de desmontar; a tela o mostra no Verificando, no Pronto, nos estados de Bluetooth (2 a 5 e 4b: o EmptyState sai, sem varredura nova) e no QR (com o meu código, o seletor volta a "Encostar"; a câmera sem leitura fecha, e, no iOS, o foco, o anúncio e a vibração esperam o `onDismiss` ou a folga de 1 s); com uma leitura do QR em andamento, espera o resultado; no 13, no 15, no 16 ou com outro cartão na tela, o da mesma pessoa é descartado, e o de outra espera e aparece pelo botão ("Cancelar pedido", "Conectar outra pessoa", "Tentar de novo"), como 21 se faltam menos de 10 s para o `actionsUntil` nessa hora; com a tela parada (18 a 20), descartado, sem vibração; com a folha do pedido de outra pessoa aberta, entra por baixo, e o foco, o anúncio e a vibração esperam a folha fechar (aceita na folha, o cartão não visto espera o 15); com o app em segundo plano, aparece na volta, com o foco e o anúncio nessa hora; entra com fade de 200 ms, sem fade com Reduzir movimento. **Saída do cartão** (todos): "Cancelar", "Voltar", "Recusar" e o vencimento voltam ao início do Encostar pelo Verificando, nunca à câmera nem ao QR: o Pronto (foco no título, sem reiniciar a varredura, P7), o estado de Bluetooth que valer (foco no título do EmptyState, pelo `titleRef`) ou, sem suporte, o QR com a faixa T30 (foco nela). **Bluetooth com o cartão na tela** (11, 12, 13, 21 e o Bloqueado): o Bluetooth desligado e o erro do rádio não mudam a tela; a saída leva ao 4; religado, a varredura recomeça no Pronto. **Foco no estado de início** (C1 e S2 da `ux.md` §11.17, acrescentado em 2026-10-31): o foco vai ao título do EmptyState de Bluetooth ou à faixa T30 também quando o Pronto sai sozinho da tela (motivo `system`: o Bluetooth desligado → 4, a permissão retirada com o anúncio falhando → 3, o celular que deixou de anunciar → faixa T30) e quando o botão tocado some nos estados de Bluetooth (motivo `bluetooth`: o "Continuar" recusado → 3; o "Continuar" que leva ao 5 → faixa T30, com a permissão dada e sem anúncio ou com o pedido do sistema falhando; a volta dos Ajustes sem resolver → 3); na abertura da aba e pelo seletor, o foco fica onde está. **Toast da saída** (C2): o T20, o "O pedido de … expirou.", o M5 (`blockedMessage`), o M7 e o M10 (`PROFILE_GONE_MESSAGE`) aparecem só com a tela de início desenhada: com o `getCapabilities` lento (400 ms), nada no Verificando; com o Pronto, anunciados depois do foco no título; sem suporte, com a faixa T30 na hora e depois do foco nela; saindo da aba no Verificando, o Toast guardado aparece na outra tela e é anunciado na hora. **Outro cartão na tela** (casos 1 e 6 da §11.17; o 2º cartão é entregue pelo `onCard` que a tela passa ao motor, porque o motor não o entrega, P8): o da mesma pessoa é descartado (a tela não muda, nada vibra nem é lido, e ele não aparece depois do "Cancelar"); o de outra pessoa espera, sem vibrar nem ser lido, e, com "Cancelar" no da tela, aparece direto, sem o Pronto e sem Toast; quando o da tela vence (17), o que esperava aparece sem esperar a conferência (o 11, ou o 21 se faltam menos de 10 s), e o T20 sai na hora: no leitor de tela, o foco no nome do novo, o T20 e o anúncio do novo (A3 ou A7), nessa ordem | U (app: `useTouch.test.tsx`, `helpers.test.ts`, `connect-card-arrival.test.tsx`, `connect-card-queue.test.tsx`, `connect-session-end.test.tsx`, `TouchCard.test.tsx`; ui: `EmptyState.test.tsx`) | 4 |
| PROX-70 | **App: cartão atrasado (estado 21), cartão sem Conectar (estado 22) e aviso aos 7 s (BAIXO 7, A3-3 item 8 e A3-4)** | **Motor**, na chegada: `actionsUntil` = chegada + `min(55 s, pairExpiresInS × 1000)`; `late` = `pairExpiresInS × 1000 < 10 s` (`lateCardBelowMs`): 0 e 5 → sim, 10 e 55 → não; `canConnect` = o rótulo é o token do relato (falso no cartão devido com o token nunca emitido, A2-2); o cartão não leva o `pairExpiresInS`. **Ordem de escolha** (`cardVariantOf`): Bloqueado → 14 → 12 → 21 → 22 → 11, também com tudo ao mesmo tempo. **21** (`pairExpiresInS` 0 e 5): sem Conectar, ‹Cancelar› e a linha; o T47 com o primeiro nome e o (Voltar); o foco no nome e o T47 (A7) depois, em fila; a vibração do cartão; sem tela acesa; depois de 60 s continua, sem o T20; na volta do segundo plano, igual; "Voltar" → Pronto, com o foco no título, sem Toast e sem pedido; com o pedido já pendente, o 14 sem a linha, com Aceitar e Recusar até o prazo do pedido (além do par) e, no fim dele, Pronto + "O pedido de … expirou."; o pedido que chega com o 21 na tela o transforma no 14 (vibração leve e o A5 depois do foco no título); de quem já é conexão, o 12 com a linha. **`pairExpiresInS` 10:** o 11, com as ações por 10 s, o ‹Bloquear› até os 7 s (M7: confirmado aos 6,5 s, chama a API; aos 7,5 s, não, com o `PROFILE_GONE_MESSAGE`) e o 17 com o T20. **22:** o T48 com o primeiro nome no lugar do T15; ordem nome → @ → T48 → Voltar → Denunciar → Bloquear; o foco no nome e o T48 (A8) depois; a tela acesa; a linha até o `actionsUntil` e, nele, o 17 com o T20; nenhum pedido de conexão sai; ‹Bloquear› com 204 → o Bloqueado; ‹Denunciar› → o formulário com o T46; bloqueando, o (Voltar) e o ‹Denunciar› desativados. **TouchCard:** o 14 de um cartão atrasado nunca mostra a linha (nem para sumir com o fade). **Textos:** T47 e T48 na redação exata da `ux.md` §11.9 (propostos, a aprovar pelo PO, A3-PO-2) e sem jargão. **Aviso aos 7 s:** `confirmWarnAfterMs` = 7000 ≥ `(janela + 2 × intervalo) × 1000` e < `reportForMs`; sem confirmação, o "Encostou!" fica até os 7 s e o T11 sai aos 7 s; o casamento aos 8 s, depois do aviso, ainda abre o cartão (9 → 11) | U (app: `useTouch.test.tsx`, `helpers.test.ts`, `TouchCard.test.tsx`, `connect.test.tsx`, `connect-card-arrival.test.tsx`) | 4 |

### 6.6 Autenticação (AUTH)
| ID | Cenário | Resultado esperado | Camada | Fase |
|---|---|---|---|---|
| AUTH-01 | Cadastro válido | 201; resposta sem `password`/hash; `account_type` gravado; e-mail e handle minúsculos | E | 1 |
| AUTH-02 | **Senha fraca** | 7 caracteres → 400 `WEAK_PASSWORD`; 8 → ok; lista de senhas comuns (`12345678`, `senha123`, `password`, `sussurro`) → 400; acima do máximo (proposta: 128 caracteres) → 400, sem rodar o argon2 (anti-DoS); senha com `ç` em NFC e em NFD → o login funciona nas duas formas (normalização NFC antes do hash) | U/E | 1 |
| AUTH-03 | **E-mail duplicado** | formato inválido → 400; duplicado → 409; `Ana@X.com ` (maiúsculas e espaço) igual a `ana@x.com` → 409 | E | 1 |
| AUTH-04 | **Handle duplicado ou reservado** | regex `^[a-z0-9._]{3,30}$`; 2 ou 31 caracteres → 400; maiúsculas convertidas pelo app e recusadas pela API se chegarem (definir); duplicado → 409; reservado (`admin`, `sussurro`, `suporte`, `root`, `api`, `www`, `dev`, `me`, `help`, `null`, `undefined`, `moderacao`…; lista em `packages/shared`) → 400 `HANDLE_RESERVED`; só pontos/underscores (`...`, `___`) → 400 (definir, A-29) | U/E | 1 |
| AUTH-05 | `accountType` | ausente → `personal` (padrão da especificação) ou 400 (definir); valor fora do enum → 400 | E | 1 |
| AUTH-06 | Login | correto → access (15 min) + refresh; senha errada e e-mail inexistente → mesmo 401, mesma mensagem, tempo parecido (hash fictício no e-mail inexistente) | E | 1 |
| AUTH-07 | Rate limit | 6º login no minuto (IP+e-mail) → 429; 21º por IP → 429; 6º cadastro na hora pelo mesmo IP → 429 | E | 1 |
| AUTH-08 | **Refresh rotativo e reuso** | R1 → R2; R1 de novo em ≤ 20 s → novo par e R2 revogado; R1 depois de 20 s → 401 e **família inteira** revogada (R2, R3… inválidos); famílias de outros aparelhos intactas | E | 1 |
| AUTH-09 | Refresh inválido | vencido (30 d, via relógio), revogado por logout, de conta excluída → 401 | E | 1 |
| AUTH-10 | Single-flight no app | 5 requisições recebem 401 ao mesmo tempo → 1 chamada de refresh e 5 repetições; refresh com 401 → tela Entrar + Toast "Sua sessão expirou" | C (MSW) | 1 |
| AUTH-11 | JWT adulterado | expirado, assinatura de outro segredo, `alg: none`, `kid` desconhecido, `acct` alterado → 401 | E | 1 |
| AUTH-12 | Logout | `logout` revoga a família (e desativa o push token a partir da Fase 6); `logout-all` revoga todas; access token antigo segue válido até 15 min (documentado), exceto conta excluída | E | 1 |
| AUTH-13 | Persistência no app | matar e reabrir o app mantém a sessão (refresh no secure-store); o access token não é gravado em disco | C + M | 1 |
| AUTH-14 | Mensagens | erros mostram texto do `ux.md` §5.1, nunca o `code` técnico | C | 1 |

### 6.7 Exclusão de conta (CONTA)
| ID | Cenário | Resultado esperado | Camada | Fase |
|---|---|---|---|---|
| CONTA-01 | `DELETE /me` (com senha, se D-UX18 = sim) | 204; senha errada → 401; `deleted_at` preenchido; todas as famílias de refresh revogadas; login seguinte → mesmo 401 de credencial inválida | E | 1 |
| CONTA-02 | Some de tudo **na hora** | busca (criador), `GET /users/:handle` → 404, posts → 404, feed dos outros, contadores dos outros (conexões, criadores, seguidores) | E | 1 (perfil/login), 2 (feed/posts), 3 (busca/contadores) |
| CONTA-03 | Comentários e curtidas do excluído | somem (ou ficam anonimizados; definir, A-13) e os contadores desnormalizados são ajustados | E | 2 |
| CONTA-04 | Pedidos e tokens de proximidade | pedidos pendentes cancelados, tokens invalidados | E | 4 |
| CONTA-05 | Hard delete (job, até 30 dias) | linhas e objetos S3 removidos; nenhum contador inconsistente depois | I | 1 (job), 2 (S3) |
| CONTA-06 | Handle depois da exclusão | definido pelo PO (proposta: fica bloqueado, A-14) | E | 1 |
| CONTA-07 | Access token do excluído ainda dentro dos 15 min | 401 (o guard checa `deleted_at`; cache ≤ 30 s, a definir) | E | 1 |

### 6.8 Mídia (MID)
| ID | Cenário | Resultado esperado | Camada | Fase |
|---|---|---|---|---|
| MID-01 | **1 a 4 imagens** | 0 itens → 400; 1 e 4 → ok; 5 → 400; app impede a 5ª seleção com Toast "Até 4 fotos por publicação." | E/C | 2 |
| MID-02 | **Tipo** | `image/jpeg|png|webp` aceitos; `image/heic`, `image/gif`, `application/pdf`, `video/*` em post de foto → 400 | E | 2 |
| MID-03 | **Tamanho** | 15 MB exatos → ok; 15 MB + 1 byte → 400; declarado 1 MB e PUT de 2 MB → recusado pelo S3 (Content-Length assinado). **Validar no spike que o emulador faz essa recusa**, senão o teste passa à toa (A-22) | E | 0 (spike), 2 |
| MID-04 | Magic bytes | HTML ou SVG declarado como `image/jpeg` → worker marca `failed`, post `failed`, nada é servido | I | 2 |
| MID-05 | **EXIF/GPS removido** | `jpeg-gps.jpg`, `png-exif.png`, `webp-exif.webp` → `full` e `thumb` sem EXIF, XMP, IPTC nem GPS (verificado com `exifr`/`sharp().metadata()`); `rotated-90.jpg` sai na orientação certa | I + M (foto real de iPhone com localização) | 2 |
| MID-06 | Bomba de descompressão | PNG de 30000×30000 px → `failed` pelo `limitInputPixels`, sem derrubar o worker | I | 2 |
| MID-07 | **URL pré-assinada expirada** | PUT depois do TTL → 403 do S3; `publish` → 409/422 `MEDIA_NOT_UPLOADED`. Validar a expiração no emulador (spike) | E | 0 (spike), 2 |
| MID-08 | `publish` | de rascunho de outra pessoa → 404; duplo → idempotente; sem upload → `MEDIA_NOT_UPLOADED` | E | 2 |
| MID-09 | **Post com mídia ainda processando** | não aparece no feed nem no perfil de terceiros; `GET /posts/:id` por terceiro → 404; o autor vê com status e a faixa "Publicando…" | E/C | 2 |
| MID-10 | Falha | 1 de 4 imagens falha → post `failed` (definir); mensagem vai para a DLQ após 3 tentativas; app mostra "Tentar de novo" | I/C | 2 |
| MID-11 | Exclusão de post | objetos `media/` removidos; URL já emitida para de funcionar quando expirar (até 6 h, A-19) | I | 2 |
| MID-12 | Rascunho órfão (> 24 h) | removido com os objetos de `incoming/` | I | 2 |
| MID-13 | Avatar | mesmo pipeline e mesmos casos MID-02 a MID-06 | E | 2 |
| MID-14 | Reel (Fase 5) | 90 s → ok; 91 s → 400; 200 MB + 1 byte → 400; `.mov` HEVC do iPhone aceito; poster gerado; GPS do container removido (**só verificável com MediaConvert real**, A-21; roteiro pós-apply em §8.2) | E + M | 5 |

### 6.9 Texto e limite de 280 (TXT)

**Regra proposta (decisão do PO, A-09):** contar **code points Unicode depois de normalizar em NFC e trocar `\r\n` por `\n`**. É o que o `CHECK (char_length(text) <= 280)` do Postgres já conta. A função `countPostChars()` fica em `packages/shared` e é usada pelo Zod da API **e** pelo contador do app. O app **não pode usar `string.length`**, que conta unidades UTF-16 (um emoji vale 2).

| ID | Entrada | Contagem esperada | Resultado |
|---|---|---|---|
| TXT-01a | `"a"` × 280 / × 281 | 280 / 281 | aceito / 400 |
| TXT-01b | `"😀"` × 280 (JS `.length` = 560) | 280 | aceito |
| TXT-01c | `"😀"` × 281 | 281 | 400 |
| TXT-01d | `"👨‍👩‍👧"` (família com ZWJ) | 5 (1 grafema) | documentado: o contador mostra 5 |
| TXT-01e | `"🇧🇷"` | 2 | idem |
| TXT-01f | `"é"` decomposto (`e` + U+0301) | 1 após NFC | aceito |
| TXT-01g | 279 `a` + 1 emoji | 280 | aceito |
| TXT-01h | vazio, só espaços, só quebras de linha, só U+200B | — | 400 (texto vazio após `trim` e remoção de invisíveis; definir) |
| TXT-01i | `"linha1\r\nlinha2"` | 13 | `\r\n` vira `\n` |
| TXT-02 | Todas as fixtures acima | mesma contagem no app (Jest) e na API (Vitest), lidas do mesmo JSON | — |
| TXT-03 | Contador na tela Criar | cinza até 260, preto de 261 a 280, `danger` acima de 280, "Compartilhar" desabilitado acima de 280 e com texto vazio | C |
| TXT-04 | Outros limites com a mesma função | comentário 500, legenda 2200, bio 150, nome 60 | U/E |

Se o PO preferir grafemas (o emoji de família vale 1), a função passa a usar `Intl.Segmenter`. **Risco:** confirmar se o Hermes do RN 0.88 tem `Intl.Segmenter`; o `CHECK` do banco teria de sair, porque o Postgres não conta grafemas.

### 6.10 Notificações (NOT)
| ID | Cenário | Resultado esperado | Camada | Fase |
|---|---|---|---|---|
| NOT-01 | **Agregação anônima**: 3 pessoas seguem o criador no mesmo dia | 1 notificação `new_followers` com `count = 3`, `actor_id NULL`, `payload` sem ids; texto "3 novas pessoas começaram a seguir você." | E | 6 |
| NOT-02 | Canário de seguidores | seguidores `canary_follower_*`: nenhuma resposta de `/notifications`, `/unread-count`, perfil ou push do criador contém os handles | E | 6 |
| NOT-03 | Virada do dia | follow às 23:59 e às 00:01 de America/Sao_Paulo → 2 buckets; no app, "Hoje"/"Esta semana" coerentes (A-35) | E/C | 6 |
| NOT-04 | Unfollow e novo follow | unfollow não decrementa; seguir de novo no mesmo dia soma 1 (aceito no ADR 0011); rate limit de 10/min no par | E | 6 |
| NOT-05 | Singular e plural | 1 → "1 nova pessoa começou a seguir você."; N → "N novas pessoas começaram…"; avatar "+N" | C | 6 |
| NOT-06 | Não lida | incremento zera `read_at` e o ponto azul volta; `POST /notifications/read {upTo}` limpa | E/C | 6 |
| NOT-07 | Curtidas | curtir/descurtir repetido → 1 notificação; curtir o próprio post → nenhuma | E | 6 |
| NOT-08 | Push | sem a íntegra do comentário; push de seguidores (se existir) também agregado e anônimo; `DeviceNotRegistered` desativa o token | I + M | 6 |
| NOT-09 | Origem excluída | post ou autor excluído → a notificação some | E | 6 |

---

## 7. Rastreabilidade

| Grupo de casos | Histórias do `backlog.md` |
|---|---|
| PERM | 1.5, 1.6, 1.8, 2.6, 2.7, 3.3, 3.6, 3.7, 3.8, 4.8 |
| CNT | 1.5, 2.7, 2.8, 3.4, 4.6 |
| BUS | 3.1, 3.2 |
| FEED | 2.5, 3.9, 4.9 |
| PROX | 4.2 a 4.11 |
| AUTH | 1.1 a 1.4 |
| CONTA | 1.7 |
| MID | 2.2, 2.3, 2.4, 2.9, 2.11, 5.2, 5.3 |
| TXT | 2.1, 2.8, 1.6 |
| NOT | 6.1 a 6.5 |

Regra: um caso só é considerado coberto quando existe um teste com o ID no nome e ele roda no CI (ou, para MAN-*, quando há evidência registrada).

---

## 8. Testes manuais guiados (aparelhos físicos)

Roteiros curtos, executados no fim de cada fase. Cada execução registra aparelho, SO, ID do build EAS, SHA do commit, data, resultado e evidência.

| ID | Roteiro | Fase | Aparelhos mínimos |
|---|---|---|---|
| MAN-APP-01 | Instalar o dev build, abrir, ver splash, ícone, fontes Inter/Bricolage e catálogo; girar o aparelho (só retrato) | 0 em diante | 1 iPhone + 1 Android |
| MAN-A11Y-01 | Fluxos da fase com VoiceOver e TalkBack; fonte do sistema no máximo; Reduzir movimento. (Acrescentado em 2026-10-31, ADR 0012 A3 e `ux.md` §11.15; ainda não executado.) No Conectar: o 21 (o foco no nome, o T47 lido depois, sem ser cortado; só o "Voltar"); o 22 (o foco no nome, o T48 depois; a ordem Voltar → Denunciar → Bloquear); o cartão que chega no QR com o meu código e com a câmera aberta (o foco só vai ao nome depois de a câmera sair, sem o sistema levá-lo a outro lugar nem cortar o anúncio do cartão; no iOS, depois do `onDismiss`); o cartão que chega com a folha do pedido de outra pessoa aberta (nada do cartão é lido nem vibra até a folha fechar); a saída do cartão para o EmptyState de Bluetooth (o foco no título) e, sem suporte, para a faixa T30 (o foco nela); o Bloqueado depois de 60 s, ainda com o ‹Denunciar› e com a tela podendo apagar. (Acrescentado em 2026-10-31, `ux.md` §11.17, C1, C2 e S2.) O Bluetooth desligado com o Pronto na tela (Central de Controle no iOS, painel rápido no Android): o foco vai ao título do EmptyState (no iOS, conferir se o evento de foco não se perde com a Central aberta, §11.12 item 7); o "Continuar" recusado e a volta dos Ajustes sem resolver: o foco no título do 3; o cartão que vence (T20), o pedido do 14 que expira e o "Bloquear" no 12 (M5): primeiro o título do Pronto, depois o Toast, lido inteiro e sem ser cortado, também num aparelho lento (iPhone recriando o gerenciador do Bluetooth, Android de entrada). O caso 6 (dois cartões, com o T20 entre o nome e o anúncio do novo) o aparelho não produz (P8): fica só no teste automático | 0 em diante | idem |
| MAN-AUTH-01 | Cadastro → login → fechar o app à força → reabrir logado → logout → excluir conta | 1 | idem |
| MAN-UP-01 | Publicar 4 fotos reais, incluindo HEIC de iPhone com localização ligada; baixar a imagem servida e conferir com `exifr` que não há GPS; repetir em 4G fraco e saindo do app durante o upload | 2 | idem |
| MAN-FEED-01 | Feed com seed: ordem, "Você está em dia" nas 3 abas, puxar para atualizar, offline | 2 | idem |
| MAN-BLE-01 | Descoberta: os dois com Conectar aberto; tempo até aparecer na lista (meta < 10 s); faixa "bem perto/por perto". ADR 0012: a lista e as faixas saíram; a meta passa ao spike 4.1-B (ADR 0012 §8), em cada par e nos dois sentidos (I1↔I2, I1↔A1, I2↔A2, A1↔A2), com as três capas: encosto detectado **e casado no servidor** em até 3 s em ≥ 95% de 20 tentativas; nenhum `encostado` a 30 cm ou mais em 5 min parado; `quase` em no máximo 5% das leituras a 1 m ou mais; mediana até casar ≤ 2 s. A1: o Android roda com `HIGH` e com `MEDIUM` (duas rodadas) e fica o nível cuja mediana de RSSI, no mesmo receptor e nas mesmas posições (5, 15 e 30 cm), fica mais perto da do iPhone emissor (empate: o mais baixo); o detector usa só `advertiserTxDbm` (0), nunca o campo do anúncio, e o anúncio sai sem o campo TX nos dois sistemas (PROX-28). A2: o casamento depende dos dois relatos dentro de 5 s do primeiro relato de cada lado; contar também os encostos que o app mostrou como `encostado` e o servidor não casou (atraso entre os aparelhos), e registrar o tempo da 1ª resposta do relato (o prazo de 8 s do PROX-57 supõe até 2 a 3 s) | 4 | matriz 8.1 |
| MAN-BLE-02 | Pedido, aceite e "Conectados" nos dois; pedidos simultâneos (os dois tocam juntos) | 4 | matriz 8.1 |
| MAN-BLE-03 | Bluetooth desligado, permissão negada, app em background no meio da busca, tela bloqueada. (Acrescentado em 2026-10-31, ADR 0012 A3; ainda não executado.) **Bluetooth com o cartão na tela:** desligar o Bluetooth (Central de Controle no iOS, painel rápido no Android) com o 11, o 21, o 22, o Bloqueado e o Aguardando na tela: a tela não muda; "Cancelar", "Voltar" e "Cancelar pedido" levam ao estado de Bluetooth, com o foco no título; religado, o Pronto volta e o encosto funciona. **Rede de verdade (R23, PROX-68):** no Confirmando, modo avião por uns 3 s e por uns 15 s, e a troca do Wi-Fi para os dados móveis: com a queda de até uns 10 s, o cartão ainda chega (ou o T11 aos 7 s), sem "Sem internet"; com mais, o estado 18 aparece uns 10 s depois da queda, e não na hora; o relato com a conexão travada termina em uns 4 s (o relato seguinte sai, visível no log de rede do build de desenvolvimento), ou seja, o `fetch` do React Native respeita o `AbortSignal` ou a corrida com o prazo encerra a chamada; 5 min de quedas repetidas sem nenhum 429 | 4 | matriz 8.1 |
| MAN-BLE-04 | Multidão: 3 ou mais aparelhos com a tela aberta; escolher a pessoa certa; rate limit não dispara em 5 min de uso normal | 4 | 3+ aparelhos |
| MAN-BLE-05 | Privacidade do anúncio com nRF Connect (PROX-28): sem nome e sem o campo TX Power nos dois sistemas; só o UUID com o prefixo; troca a cada 20 s | 4 | 1 Android extra ou o próprio |
| MAN-BLE-06 | **Linha "atacante" do spike 4.1-B** (ADR 0012, Adendo A1, revisto em 2026-10-30; risco R21). **Transmissor fora do app** (notebook, dongle nRF52840, ESP32 ou módulo com amplificador) anunciando o UUID com o `bleToken` de uma conta de teste M, pego pela API e renovado a cada 20 s. **Vítima:** I1 e A1 (um receptor de cada sistema), com a tela Encostar aberta, o CSV da `/dev/proximidade` ligado e os limiares **finais** do spike. **Parte 1, regressão do A1 (portão):** a 1 m, com +8 dBm, campo TX declarado -21, -100 e sem campo, 5 min cada; a distribuição de estados no receptor precisa ser a mesma nas três (diferença = bug e reprova; ver PROX-44). **Parte 2, resíduo, afastando o transmissor:** configurações +8 dBm com antena omni, +20 dBm com antena omni e +20 dBm com **antena direcional obrigatória** (8 a 14 dBi, patch ou yagi de 2,4 GHz) apontada para a vítima; passos de **1, 2, 3, 5, 7, 10 e 15 m**, com linha de visada (corredor ou salão) e repetidos numa sala comum, com móveis; até 5 min por passo, anotando o tempo em `encostado`, os relatos com o token de M e se houve casamento (a conta M relata o token da vítima por script); para no primeiro passo com 5 min sem nenhum `encostado`, e o resíduo é o maior passo com `encostado` (a 15 m ainda com `encostado`: "≥ 15 m"). +30 dBm não é transmitido (limite legal): estimar somando 10 dB ao resultado de +20 dBm com antena direcional (cerca de 3,2× a distância, marcado como estimativa); sem módulo de +20 dBm, rodar em +8 dBm e estimar o +20 dBm (+12 dB, cerca de 4× a distância, estimativa). **Parte 3, endereço Bluetooth (R17):** com o nRF Connect num terceiro aparelho, anotar o endereço do anúncio do A1 em pelo menos 10 rotações do token e o do I1 por 20 min. **Critério:** parte 1 sem diferença; distâncias da parte 2 dentro da ordem de grandeza do R21 (se passarem, o Tech Lead leva ao PO antes de fechar a Fase 4). Conferir também, com o script de M, o A2 no servidor: M casa com no máximo 10 vítimas novas por hora (PROX-45) e cada vítima recebe o cartão de M (PROX-49) | 4 | I1 + A1 + transmissor externo + 1 aparelho com nRF Connect |
| MAN-QR-01 | QR: mostrar e ler; permissão de câmera negada; QR cruzado (D7); câmera do sistema abrindo o deep link. (Acrescentado em 2026-10-31, ADR 0012 A3-3 item 6 e `ux.md` §11.15; ainda não executado.) **Cartão que chega com o QR aberto:** A encosta em B e vai ao QR antes de o cartão chegar (com a rede lenta, ou o modo avião por 2 a 3 s logo depois do encosto): (a) com o meu código na tela, o cartão entra no lugar do QR, com o seletor em "Encostar" por baixo; (b) com a câmera aberta e nada lido, a câmera fecha e o cartão aparece: no **iOS**, o `Modal` sai com a animação, e a vibração, o foco e o anúncio só vêm depois do `onDismiss` (ou da folga de 1 s), sem ficar presos; no **Android**, a câmera fecha na hora, o "voltar" do sistema não reabre a câmera e o cartão recebe o foco; (c) com um QR lido e o pedido saindo, o cartão espera o resultado (no Aguardando da mesma pessoa, não aparece). Em todos, "Cancelar" e "Voltar" levam ao Encostar, nunca de volta à câmera ou ao QR | 4 | 2 aparelhos |
| MAN-CON-01 | Meta de UX: duas pessoas se conectam em < 30 s sem ajuda (`ux.md` §10) | 4 | 2 aparelhos |
| MAN-REEL-01 | Gravar e publicar reel de 90 s e de 91 s; `.mov` HEVC do iPhone; não avança sozinho no fim | 5 | idem |
| MAN-PUSH-01 | Permissão, receber push com o app fechado, tocar e abrir a tela certa, logout para de receber | 6 | idem (iOS exige APNs pelo EAS) |

### 8.1 Matriz de aparelhos

As versões mínimas de SO dependem do Expo SDK 58 (deployment target iOS e `minSdkVersion` Android). **Confirmar na Fase 0** com `expo-doctor` e o `app.config.ts`, e o PO decide o piso de suporte (A-36). Proposta de matriz:

| ID | Aparelho (sugestão) | SO | Por quê |
|---|---|---|---|
| I1 | iPhone recente (o do PO) | iOS atual (27.x) | aparelho principal |
| I2 | iPhone mais antigo (XR/11/SE 2ª geração) | iOS mínimo suportado pelo SDK 58 | BLE iOS↔iOS exige **dois** iPhones |
| A1 | Samsung Galaxy (One UI) | Android 15 ou 16 | fabricante com pilha BLE própria e economia de bateria agressiva |
| A2 | Pixel, Motorola ou Xiaomi | Android 12 ou 13 | permissões novas de BLE (`BLUETOOTH_SCAN/ADVERTISE/CONNECT`) |
| A3 (opcional) | Android 10 ou 11 | API 29/30 | caminho com `ACCESS_FINE_LOCATION` para a varredura |
| A4 (simulado) | qualquer Android | — | "aparelho não anuncia": forçado por flag de dev em `getCapabilities()` |

| Par BLE | Combinações mínimas | Roteiros |
|---|---|---|
| iOS ↔ iOS | I1–I2 | MAN-BLE-01 a 03, MAN-QR-01 |
| iOS ↔ Android | I1–A1 e I2–A2 | MAN-BLE-01 a 03, MAN-QR-01 |
| Android ↔ Android | A1–A2 (e A2–A3 se houver) | MAN-BLE-01 a 03 |
| Multidão | I1 + A1 + A2 (+ I2) | MAN-BLE-04 |
| Atacante (spike 4.1-B, R21) | I1 + A1 como vítimas, transmissor externo com antena direcional, 1 aparelho com nRF Connect | MAN-BLE-06 |

Sem pelo menos **2 iPhones e 2 Androids** (ADR 0002), a Fase 4 não pode ser declarada pronta. Hoje não sabemos quais aparelhos o PO tem (pergunta P3 do `infra.md`).

### 8.2 Teste de fumaça pós-apply do MID-14 (A-21, adicionado na Fase 5a)

O MediaConvert e o EventBridge não têm emulação, e o `apply` é proibido até a Fase 7. Este roteiro fecha o CA1 da 5.2 ("vídeo de iPhone com GPS sai sem localização") **depois do primeiro `apply`**, num ambiente de homologação. Ele não foi executado. Quem executa: o DevOps, com o PO.

**Pré-requisitos**
- Infra aplicada (Fase 7): bucket com `incoming/` e `media/`, role do MediaConvert (lê `incoming/*`, grava `media/*`), regra do EventBridge (`source = aws.mediaconvert`, `detail-type = "MediaConvert Job State Change"`, `status ∈ {COMPLETE, ERROR}`, `userMetadata.app = sussurro`) → SQS `video-events` com DLQ, CloudFront com URL assinada.
- Worker com `NODE_ENV=production`, `VIDEO_PROCESSOR=mediaconvert`, `MEDIACONVERT_ROLE_ARN` (e, se houver, `MEDIACONVERT_QUEUE_ARN`) e `SQS_QUEUE_VIDEO_EVENTS=video-events`. O log do worker na subida diz `vídeo: mediaconvert`.
- Ferramentas no PC de quem testa (fora do repositório): `exiftool` e, se quiser, `ffprobe`.
- Vídeos gravados para o teste, **nunca vídeos pessoais**:
  - V1: iPhone, câmera nativa, com a localização da Câmera ligada, vertical, 20 a 30 s, `.mov` HEVC;
  - V2: Android, câmera nativa, com a localização ligada, vertical, 20 a 30 s, `.mp4`;
  - V3: 89 a 90 s; V4: 91 s ou mais; V5: sem áudio; V6: gravado com o celular deitado (paisagem).
- Antes de enviar, confirmar que V1 e V2 **têm** localização: `exiftool -a -G1 -s -ee V1.mov` mostra `GPS`, `Location`, `ISO6709` ou `©xyz`. Sem achado aqui o teste passaria à toa: grave de novo.

**Passos**
1. Pelo app (dev build apontando para a homologação), publicar V1 como reel. Anotar o `postId` e o `mediaId` (`GET /v1/posts/:id` como o autor).
2. Enquanto processa: o autor vê "Processando o reel…"; uma conexão do autor **não** vê o reel no feed (`GET /v1/feed?type=reel`), no perfil nem no detalhe (404). No console do MediaConvert, o job tem `userMetadata.app = sussurro` e `userMetadata.mediaId` igual ao `mediaId`.
3. Ao terminar: o post vira `published` e aparece na aba Reels da conexão, com a duração; `incoming/{autor}/{mediaId}` e `incoming/{autor}/{mediaId}-poster` **não existem mais** no bucket (`aws s3api head-object` → 404).
4. Baixar o MP4 da URL assinada do `GET /v1/posts/:id` (`media[0].url`) e o poster (`thumbUrl`).
5. **Critério do MID-14 (localização):** `exiftool -a -G1 -s -ee video.mp4` e `exiftool -a -G1 -s poster.jpg` não mostram nenhuma tag de GPS, `com.apple.quicktime.location.ISO6709`, `©xyz`, `Location`, `UserData:GPSCoordinates` nem XMP com coordenadas; e o arquivo não contém a string de coordenadas que o pré-requisito mostrou em V1 (`grep -c` com o valor real → 0).
6. Também: `ffprobe video.mp4` mostra H.264 + AAC, 720×1280 (ou com faixas pretas, sem distorção, se o original não for 9:16), `moov` no começo (começa a tocar antes de baixar inteiro) e o vídeo em pé (rotação aplicada nos pixels, sem matriz de rotação).
7. Repetir 1 a 6 com V2 (Android).
8. V3 (90 s) publica. V4 (91 s): o app nem deixa escolher, e um rascunho forçado com 91 s dá 400. Se o seletor disser 90 s e o arquivo medir um pouco mais, o worker aceita até 90,5 s; acima disso o post vira `failed` sem criar job (só o autor vê, com "Tentar de novo" e "Excluir").
9. V5 (sem áudio) e V6 (paisagem) publicam e tocam. Se V5 falhar com erro de áudio, registrar o código do MediaConvert: o seletor de áudio do job precisa de ajuste.
10. Falha: enviar pela URL do rascunho (com `curl`) um arquivo corrompido renomeado para `.mp4`. O post vira `failed` sem criar job no MediaConvert, e ninguém além do autor o vê.
11. A DLQ da `video-events` continua vazia depois dos passos acima (sem alarme no CloudWatch).

**Registro:** prints e as saídas do `exiftool`, com as coordenadas reais trocadas por `<removido>`, em `docs/evidencias/fase-7/MID-14/`, com a data, o SHA e a região. Se o passo 5 achar qualquer localização, o MediaConvert **não** está tirando o metadado: bloquear os reels em produção (sem criar rascunho de reel) e levar ao arquiteto antes do lançamento.

---

## 9. Definition of Ready e Definition of Done

### 9.1 Definition of Ready (história pode entrar em desenvolvimento)
- [ ] Critérios de aceite no formato Dado/Quando/Então no `backlog.md`, incluindo cenários negativos e de borda, com os IDs de casos deste documento.
- [ ] Nenhuma decisão 🔶 pendente que mude o comportamento testável (se houver, a história fica fora da fase).
- [ ] Contrato da API esboçado (rota, schemas Zod de request/response, códigos de erro) e coerente com a `arquitetura.md`.
- [ ] Tela com wireframe ou página do protótipo e estados (carregando, vazio, erro, offline) definidos no `ux.md`.
- [ ] Dados de teste definidos (factory, seed ou fixture).
- [ ] Dependências entregues (histórias anteriores, contas, aparelhos).
- [ ] Estimativa feita e cabe na fase.

### 9.2 Definition of Done geral (toda história e toda fase)
- [ ] Código revisado em PR, título em Conventional Commits, link para a história.
- [ ] `pnpm check` verde (format, lint 0 avisos, typecheck, unit) e `pnpm test:e2e` verde, local e no CI.
- [ ] Testes novos cobrindo os CAs, com os IDs no nome; os casos de permissão demonstram falhar sem a regra.
- [ ] Metas de cobertura do pacote mantidas (seção 4); nenhuma queda.
- [ ] **Regras de permissão verificadas no servidor**: casos PERM/PROX/FEED da história verdes; **canário (PERM-10) verde** a partir da Fase 3.
- [ ] Toda rota nova tem schema de resposta em `packages/shared` e entra no canário e na matriz de 401/403.
- [ ] Mensagens de erro e estados conforme o `ux.md`; a11y básica (role, label, alvo de 44).
- [ ] Nenhum segredo no repositório (gitleaks verde); `.env.example` atualizado.
- [ ] README atualizado (ver 9.4).
- [ ] Evidência em iOS e Android para histórias com tela (ver 9.4).
- [ ] PO aceitou a demonstração.

### 9.3 Definition of Done por fase

O critério do PO tem quatro partes. A tabela diz como cada uma é verificada em cada fase.

| Fase | "Testes passam" (obrigatórios) | "Permissões no servidor" | "Roda no iOS e Android (dev build)": o que se demonstra | "README atualizado" |
|---|---|---|---|---|
| 0 | Checklist da seção 10 inteiro | n/a (não há domínio); PERM-18 começa na Fase 1 | MAN-APP-01: splash, fontes, catálogo, `/dev/catalog` bloqueado no `preview` | setup no Windows em até 5 comandos, testado por outra pessoa (ou pelo QA) numa cópia limpa |
| 1 | AUTH-*, CONTA-01/02/05/06/07, PERM-06 (users), 07, 11, 12, 13 (dono/inexistente), 17 (log), 18 | idem; criador e pessoal com navegação própria | MAN-AUTH-01; criador não vê Início/Pesquisar/Conectar | como rodar migrations e seed; variáveis novas |
| 2 | FEED-*, MID-01 a 13, TXT-*, CNT-04/05, PERM-14/15/16, CONTA-03 | posts de pessoal só para conexões (com seed) | MAN-UP-01 (foto real com GPS), MAN-FEED-01 | seed, emuladores S3/SQS, como ver o feed sem conexões reais |
| 3 | BUS-*, PERM-01 a 05, 08, 09, **10**, 10b, 10c, 13, CNT-01/02/03, FEED-11 | canário e matriz de criador verdes | busca, seguir, perfil de criador, listas próprias | seção "Privacidade e testes de permissão" |
| 4 | PROX-01 a 28, 30 a 70, PERM-05 (proximidade), CNT-03, CONTA-04 | protocolo inteiro | MAN-BLE-01 a 06 (o 06 é a linha "atacante" do spike 4.1-B), MAN-QR-01, MAN-CON-01 na matriz 8.1 (**dois iPhones obrigatórios** para iOS↔iOS) | permissões de BLE, como testar com um aparelho só (QR + `/dev`) |
| 5 | MID-14 (exceto GPS em vídeo), FEED-05 (reel) | reels de pessoal só para conexões | MAN-REEL-01 | limites e `VIDEO_PROCESSOR` |
| 6 | NOT-*, PROX-29, PERM-17 (Sentry) | anonimato de seguidores | MAN-PUSH-01 (exige APNs configurado pelo EAS) | push e Sentry (DSN) |
| 7 | `terraform fmt -check`, `validate`, `tflint`, `trivy config` verdes; regressão completa | regressão | regressão de MAN-APP-01 a MAN-PUSH-01 | runbook de deploy e rollback |

### 9.4 O que "roda no iOS" exige, e como registrar a evidência

**Honestidade sobre o iOS:**
- Sem Mac não há simulador nem Xcode. O único caminho é o **EAS Build** com distribuição interna (ad hoc).
- Isso exige **conta Apple Developer paga** (US$ 99/ano). A conta gratuita não serve: o provisionamento gratuito só funciona pelo Xcode.
- O iPhone precisa ser registrado (`eas device:create`), ter o **Modo de Desenvolvedor** ligado e estar na mesma rede do PC (ou usar túnel) para o Metro e a API.
- Cada mudança nativa (ex.: módulo BLE na Fase 4) consome um build iOS da cota Free (15/mês).
- Push no iOS (Fase 6) exige chave APNs, criada pelo EAS com a conta Apple.
- BLE iOS↔iOS exige **dois iPhones físicos**.

Enquanto a conta Apple não existir, a fase só pode ser aceita como **"⚠️ aprovada com pendência iOS"**, decisão explícita do PO registrada no README. A partir da Fase 4 o iOS deixa de ser adiável, porque o BLE no iOS é o maior risco técnico do projeto.

**Evidência proposta (leve e verificável):**
- Seção **"Estado das fases"** no `README.md`, com uma tabela por fase: data, SHA do commit, link do CI verde, IDs dos builds EAS (iOS e Android), aparelhos e SO, resultado de cada roteiro MAN-* e pendências aceitas pelo PO.
- Prints (PNG comprimido, até ~300 KB cada) em `docs/evidencias/fase-N/` com nome `<roteiro>-<plataforma>.png` (ex.: `MAN-APP-01-ios.png`).
- Vídeos curtos (BLE, QR, push) **fora do Git** (link para pasta compartilhada do PO), referenciados na tabela.
- O PR final da fase traz o checklist da DoD marcado e os links.

---

## 10. Checklist de aceite da Fase 0

Execução no PowerShell da máquina do PO, raiz `C:\dev\sussurro`. Alinhado ao `fase-0-plano.md` §8 e ao `infra.md` §1, §3 e §4. pnpm fixado em 12.13.0 (A-01 resolvido). Abaixo, `<pnpm>` = versão fixada no `packageManager`.

### 10.1 Pré-requisitos da máquina (infra §1.1)
| # | Comando | Esperado |
|---|---|---|
| F0-ENV-01 | `wsl --status` | "Versão padrão: 2" |
| F0-ENV-02 | `docker run --rm hello-world` | mensagem "Hello from Docker!" e código 0 |
| F0-ENV-03 | `node -v` · `pnpm -v` | `v26.13.0` · `<pnpm>` |
| F0-ENV-04 | `git config --get core.longpaths` · `reg query HKLM\SYSTEM\CurrentControlSet\Control\FileSystem /v LongPathsEnabled` | `true` · `0x1` |
| F0-ENV-05 | `git config --get core.autocrlf` | `false` |
| F0-ENV-06 | `Get-Content $env:USERPROFILE\.wslconfig` | `[wsl2]`, `memory=3GB` |

### 10.2 Portão do ADR 0001 (smoke test; plano do Dev S1 a S8)
| # | Comando | Esperado |
|---|---|---|
| F0-GATE-01 | `pnpm install --frozen-lockfile` | código 0; sem peer dependency não resolvido; termina em menos de 10 min |
| F0-GATE-02 | `pnpm --filter @sussurro/mobile exec expo-doctor` | nenhum problema crítico; anotar o deployment target iOS e o `minSdkVersion` (alimenta a matriz 8.1) |
| F0-GATE-03 | `pnpm --filter @sussurro/mobile exec expo export --platform android --platform ios --output-dir .smoke-export` | bundles das duas plataformas gerados |
| F0-GATE-04 | `pnpm --filter @sussurro/mobile exec expo prebuild --platform android --clean --no-install` | `apps/mobile/android` gerado sem erro de autolinking (apagar depois) |
| F0-GATE-05 | Em pasta temporária fora do repo: `pnpm init`, `pnpm add sharp @node-rs/argon2`, `node --input-type=module -e "await import('sharp'); await import('@node-rs/argon2')"` | instala sem node-gyp e importa sem erro |
| F0-GATE-06 | `pnpm build` | `apps/api/dist` e `apps/worker/dist` gerados |
| F0-GATE-07 | `git status --porcelain` depois de F0-GATE-03/04 | nenhum arquivo gerado fica para trás (`.smoke-export`, `android/` ignorados ou apagados) |

### 10.3 docker-compose (infra §3)
| # | Comando | Esperado |
|---|---|---|
| F0-DC-01 | `docker compose up -d --wait` | código 0 (confirmar que `--wait` aceita o `s3-init` que termina com 0; se não aceitar, ajustar o compose) |
| F0-DC-02 | `docker compose ps -a` | `postgres`, `valkey` e `seaweedfs` `(healthy)`; `elasticmq` `Up`; `s3-init` `Exited (0)` |
| F0-DC-03 | `docker compose exec postgres psql -U sussurro -d sussurro -c "select version()"` | PostgreSQL 18.x |
| F0-DC-04 | `docker compose exec valkey valkey-cli ping` | `PONG` |
| F0-DC-05 | `netstat -ano \| findstr "LISTENING" \| findstr ":5432 :6379 :9324"` | só `127.0.0.1` (nada em `0.0.0.0`); só a 8333 em `0.0.0.0` |
| F0-DC-06 | `docker compose down` e `docker compose up -d --wait` de novo | sobe sem erro; o bucket já existente não quebra o `s3-init` (idempotente) |
| F0-DC-07 | Spike S3/SQS (script a definir pelo DevOps/Dev, ex.: `pnpm spike:aws`) | relatório com OK/FALHA para: PUT pré-assinado do **celular** via `S3_PUBLIC_ENDPOINT_URL`; PUT com `Content-Length` maior que o assinado **recusado**; PUT depois da expiração **recusado**; HEAD; GET pré-assinado; DeleteObject; envio e recebimento SQS; visibility timeout; mensagem na DLQ após 3 recebimentos. Qualquer FALHA vira decisão (LocalStack, D2) |

### 10.4 Qualidade
| # | Comando | Esperado |
|---|---|---|
| F0-Q-01 | `pnpm format:check` | nenhum arquivo fora do padrão |
| F0-Q-02 | `pnpm lint` | 0 erros e 0 avisos |
| F0-Q-03 | `pnpm typecheck` | 0 erros em todos os pacotes |
| F0-Q-04 | `pnpm test` | todos passam em shared, db, api, worker, ui e mobile; contagem de testes > 0 em cada pacote (o relatório lista o número) |
| F0-Q-05 | `pnpm test:e2e` (compose no ar) | `health.e2e-spec.ts` e `client.int.test.ts` passam |
| F0-Q-06 | `pnpm turbo run lint typecheck test` duas vezes | a segunda termina com `FULL TURBO` |
| F0-Q-07 | Teste-sentinela: quebrar de propósito o `theme.test.ts` (trocar `#0066FF`) e rodar `pnpm --filter @sussurro/ui test` | falha; desfazer em seguida. Prova que o teste trava os tokens |
| F0-Q-08 | Teste-sentinela: tirar `decoratorMetadata` do `.swcrc` da API e rodar `pnpm --filter @sussurro/api test` | `app.module.spec.ts` falha; desfazer |
| F0-Q-09 | `pnpm test:cov` | relatórios gerados por pacote (na Fase 0 só mede; os limites valem a partir da Fase 1) |

### 10.5 API e worker
| # | Comando | Esperado |
|---|---|---|
| F0-API-01 | `pnpm dev` e `curl.exe -i http://localhost:3000/health` | `200`, `{"status":"ok"}` |
| F0-API-02 | `curl.exe -i http://localhost:3000/health/ready` | `200`, `postgres.status = "up"` e `redis.status = "up"` |
| F0-API-03 | `docker compose stop valkey` e repetir F0-API-02; depois `docker compose start valkey` | `503`, `status "error"`, `redis.status "down"`, em até ~1,5 s; volta a 200 depois do start sem reiniciar a API |
| F0-API-04 | `docker compose stop postgres` e repetir F0-API-02; depois `start` | `503` com `postgres.status "down"`; recupera sozinho |
| F0-API-05 | `curl.exe -i http://localhost:3000/v1/nao-existe` | `404`, `{"code":"NOT_FOUND","message":...}`, sem stack |
| F0-API-06 | Remover `DATABASE_URL` do `.env` e iniciar a API | processo encerra no boot com mensagem citando `DATABASE_URL`; código ≠ 0 |
| F0-API-07 | Worker: iniciar e Ctrl+C | log de início e de desligamento gracioso; código 0 |
| F0-API-08 | `curl.exe -i -H "Authorization: Bearer abc" http://localhost:3000/health` e ver o log | o valor do header não aparece no log (redact do pino) |

### 10.6 App (dev build)
| # | Ação | Esperado |
|---|---|---|
| F0-APP-01 | `pnpm --filter @sussurro/mobile exec eas build --profile development --platform android` | build concluído; APK instalado num Android físico |
| F0-APP-02 | idem `--platform ios` (exige conta Apple paga e `eas device:create`) | build concluído e instalado no iPhone com Modo de Desenvolvedor; **sem conta Apple: pendência registrada e aceita pelo PO** |
| F0-APP-03 | `pnpm dev:mobile` com o celular na mesma Wi-Fi | o app abre; ícone e splash da marca; Inter e Bricolage carregadas (conferir com o catálogo "Fundamentos") |
| F0-APP-04 | Abrir a rota do catálogo em dev | todos os componentes base com variantes e estados; aparência conferida contra p-01/p-06 com a sobreposição do protótipo (se implementada) |
| F0-APP-05 | Build `preview` (ou teste de config): abrir `sussurro://dev/catalog` | redireciona para `/`; `app-config.test.ts` prova que `preview`/`production` não têm cleartext nem ATS liberado |
| F0-APP-06 | MAN-A11Y-01 resumido no catálogo | botões e abas anunciados com papel e rótulo; fonte do sistema no máximo não corta texto; Reduzir movimento desliga animações |
| F0-APP-07 | Prints de iOS e Android | anexados ao PR final e a `docs/evidencias/fase-0/` |

### 10.7 CI (depende de D16: repositório no GitHub)
| # | Ação | Esperado |
|---|---|---|
| F0-CI-01 | Abrir PR limpo | jobs `secrets`, `quality`, `test` e `build` verdes em até ~10 min (frio) |
| F0-CI-02 | PR de teste com um erro de lint | `quality` vermelho (depois descartar o PR) |
| F0-CI-03 | PR de teste com uma chave AWS falsa num arquivo | `secrets` (gitleaks) vermelho (descartar o PR e o branch) |
| F0-CI-04 | PR de teste com um teste quebrado | `test` vermelho |
| F0-CI-05 | Log do job `test` | mostra a execução de `test` **e** de `test:e2e` contra os services |

### 10.8 Documentação
| # | Ação | Esperado |
|---|---|---|
| F0-DOC-01 | Numa cópia limpa (`C:\dev\sussurro-check`, sem `node_modules` nem `.env`), seguir só o README | do zero até `pnpm check` verde em até 5 comandos, depois dos pré-requisitos |
| F0-DOC-02 | README | pré-requisitos do Windows (WSL2, Docker, long paths, autocrlf, pnpm sem corepack), tabela de scripts, como rodar no celular, firewall, links para `docs/equipe` e a seção "Estado das fases" |

---

## 11. Ambiguidades e contradições

Severidade: 🔴 bloqueia aceite ou exige decisão antes da fase; 🟡 importante, decidir antes da fase indicada; 🟢 sugestão ou ajuste menor.

| # | Sev. | Tema | Achado (fontes) | Quem decide | Recomendação do QA |
|---|---|---|---|---|---|
| A-01 | ✅ | Versão do pnpm (resolvido na consolidação: 12.13.0 em todos os documentos) | Dev fixa 12.16.1 (`fase-0-plano.md` §3, S1); DevOps fixa 12.13.0 (`infra.md` §1.2, `eas.json`). O checklist S1 falharia em uma das máquinas | DevOps + Dev | Uma versão só, no `packageManager`, `eas.json` e README. A 12.13.0 com `minimumReleaseAge` é a mais conservadora |
| A-02 | 🔴 | "Roda no iOS" em toda fase | Exige conta Apple paga, iPhone registrado e EAS. Nenhuma das contas existe (`HANDOFF.md` §5). A Fase 0 não pode cumprir o critério como está escrito | PO | Aceitar explicitamente "aprovada com pendência iOS" nas Fases 0 a 3, com a conta criada antes do fim da Fase 3. **Fase 4 não fecha sem iOS** |
| A-03 | 🔴 | Aparelhos para a Fase 4 | BLE iOS↔iOS exige 2 iPhones; o ADR 0002 pede 2 iPhones + 2 Androids. Não se sabe quais aparelhos o PO tem (`infra.md` P3) | PO | Confirmar o inventário agora; se faltar, prever empréstimo/compra ou aceitar formalmente cobertura parcial da matriz 8.1 |
| A-04 | 🔴 | Busca e @ de conta pessoal | A especificação pede "explicar que contas pessoais só se conectam ao vivo" ao digitar o @ de uma conta pessoal, e também "contas pessoais nunca aparecem na busca". Detectar o caso confirma que a conta existe (UX D-UX5, backlog 3.2) | PO | Dica genérica sempre que não houver criador (texto do D-UX5). BUS-05 testa que a resposta é idêntica à de handle inexistente |
| A-05 | 🟡 | Outros oráculos de existência de @ pessoal | Cadastro devolve "@ em uso" (409); `PUT /creators/:h/follow` pode devolver 403 "não é criador"; comentários exibem @ de pessoais | PO + Arquiteto | Aceitar que o cadastro revele (inevitável com @ único; mitigado por rate limit de 5/h). Exigir 404 idêntico no follow (PERM-03). Documentar que a promessa é "a busca não revela", não "ninguém descobre que o @ existe" |
| A-06 | 🟡 | O que o criador pode fazer | Especificação: "Conta de criador: só publica". Backlog 2.8: "pessoa **ou criador** quer comentar"; 2.7 não diz se criador curte. O criador não tem feed nem busca, mas vê comentários nos próprios posts (p-21) | PO | Criador pode **responder e excluir comentários nos próprios posts**; não curte nem comenta em posts de outros. Regra no servidor (403) com teste |
| A-07 | 🟡 | Visibilidade de comentários (D11) | Comentário de C num post de A expõe @ e nome de C a outras conexões de A que não conectam com C, e o @ de pessoas que comentam em posts de criadores fica visível a todos os seguidores. O canário não pega isso (PERM-10c) | PO | Decidir antes da Fase 2. Se manter visível (padrão das redes), o @ só é tocável quando o perfil é visível (`profileVisible`, D-UX10) e o teste fixa o comportamento |
| A-08 | 🟡 | Feed da Fase 2 sem como criar relacionamentos | Seguir chega na Fase 3 e conectar na Fase 4. Na Fase 2 o feed no app fica sempre vazio, a não ser por seed (backlog, pergunta 3) | PO + Dev | Incluir `pnpm db:seed` com personas na Fase 1 ou 2 e declarar no DoD da Fase 2 que a demonstração usa seed |
| A-09 | 🟡 | Contagem dos 280 caracteres | Especificação não define. Arquitetura conta code points no `CHECK`; UX diz "o app também conta code points", mas o `string.length` do JS conta UTF-16 (emoji = 2); o backlog 2.1 cita code points | PO (regra) + Dev | Code points após NFC, função única em `packages/shared`, fixtures compartilhadas (TXT-01/02). Grafemas só se o PO fizer questão (custo: `Intl.Segmenter` no Hermes e tirar o `CHECK`) |
| A-10 | 🟡 | Contador "recente" de 120 s × pedido de 120 s | O `prox:r` vale 120 s a partir da **emissão** do token, e o pedido vale 120 s a partir da **criação**. B pode ter visto `tA` 20 s antes do pedido: aos 105 s a folha mostra "Expira em 0:15", mas o `tA` já venceu | Arquiteto | O app de B continua varrendo com a folha aberta e envia o `tA` mais recente (PROX-26); ou contar a validade do aceite a partir da observação |
| A-11 | 🟡 | Exclusão de conta × feed e contadores | Arquitetura §15: "some de tudo" na hora. Mas a SQL do feed (§8) não filtra `users.deleted_at`, e `connections`/`follows` só caem no hard delete (até 30 dias) | Arquiteto | Filtrar autores excluídos no CTE do feed, nos contadores e nas listas; FEED-12 e CNT-03 cobrem |
| A-12 | 🟡 | Contadores desnormalizados × cascade | `like_count`/`comment_count` ficam em `posts`, mas o hard delete apaga `likes`/`comments` por `ON DELETE CASCADE` sem decrementar | Arquiteto | Job de hard delete recalcula os contadores dos posts afetados (CNT-04, CONTA-05) |
| A-13 | 🟡 | Comentários e curtidas de conta excluída | Não definido se somem na hora, ficam como "conta excluída" ou só somem no hard delete | PO | Somem na hora (coerente com "some de tudo"), contadores ajustados |
| A-14 | 🟢 | Reuso do @ de conta excluída | Não definido. Reuso permite alguém assumir um @ que conexões antigas reconhecem | PO | @ bloqueado (nunca reutilizado na v1) |
| A-15 | 🟡 | Exclusão de conta pede senha? | UX (D-UX18) pede senha no `DELETE /me`; arquitetura §13 não prevê corpo | PO + Arquiteto | Pedir a senha; ajustar o contrato antes da Fase 1 |
| A-16 | 🟡 | Rotação de 20 s × toque em "Conectar" | Se A demora mais de 30 s para tocar, o `tB` exibido venceu e a pessoa "sai de perto", mesmo estando ao lado | Dev + UX | O app atualiza o token de cada pessoa a cada novo `resolve` (PROX-25). Medir no MAN-BLE-01 |
| A-17 | 🟡 | Rate limit de `resolve` (30/min) em lugar cheio | Com 10 pessoas rotacionando tokens a cada 20 s, são ~30 tokens novos por minuto, e o limite estoura em festas e eventos (persona Tomás) | Arquiteto | `resolve` em lote (vários tokens por chamada contando 1) ou limite por token distinto; validar no MAN-BLE-04 |
| A-18 | 🟡 | Mesma conta em dois aparelhos | `prox:u:{uid}` é uma chave só; abrir o Conectar em dois aparelhos sobrescreve. Pedido a si mesmo por outro aparelho é possível | Arquiteto | Última tela aberta vence; PROX-07 cobre "a si mesmo" entre aparelhos |
| A-19 | 🟢 | URL assinada de 6 h depois de perder acesso | Quem deixou de ser conexão (D8) ou de seguir ainda abre a mídia já carregada por até 6 h | PO | Aceitar e documentar na política de privacidade, ou reduzir para 1 h |
| A-20 | 🟡 | Teste do código nativo (Swift) | Sem Mac não há XCTest. O módulo BLE em Swift só é verificado compilando no EAS e testando à mão | PO + Dev | Manter a lógica de bytes/UUID em TypeScript (testável) e o nativo mínimo; roteiros MAN-BLE obrigatórios; Kotlin com JUnit opcional |
| A-21 | 🟡 | GPS em vídeo e MediaConvert não testáveis antes do `apply` | Em dev, o `PassthroughVideoProcessor` copia o original **com metadados**. O CA da 5.2 ("vídeo de iPhone com GPS sai sem localização") só é verificável na AWS, e o PO proibiu o `apply` | PO | Marcar o CA da 5.2 como "verificação pós-apply", com teste de fumaça pronto. Em dev, nunca subir vídeo real com localização |
| A-22 | 🟡 | Fidelidade dos emuladores | ElasticMQ/SeaweedFS podem não aplicar expiração de presign nem `Content-Length` assinado. Os testes MID-03/MID-07 passariam sem provar nada | DevOps | Incluir esses dois itens no spike da Fase 0 (F0-DC-07); se falharem, os testes rodam só como contrato e a verificação real fica para depois do apply (ou LocalStack, D2) |
| A-23 | 🟡 | Escopo de "componentes base" na Fase 0 | Especificação lista 15 componentes. Dev entrega 11 e adia PostPhoto, PostText, CommentsSheet, ProfileHeader, ReelTile e ReelViewer; o catálogo do UX (§6.15) prevê "telas compostas" e a "casca" do ReelViewer já na Fase 0 | PO | Aceitar a divisão do Dev (menos retrabalho) e tirar as telas compostas do catálogo da Fase 0; registrar no aceite |
| A-24 | ✅ | CI × scripts de teste (resolvido na consolidação: `infra.md` §4.1 ajustado) | Dev: `pnpm test` = unitário sem Docker e `pnpm test:e2e` = integração. DevOps: o job `test` roda só `turbo run test` (não roda o e2e) e inclui um passo de "migrations" que não existe na Fase 0. O filtro `--filter=!mobile` pode não casar com `@sussurro/mobile` | DevOps + Dev | Job `test` roda os dois scripts (F0-CI-05); passo de migrations só a partir da Fase 1; usar o nome completo do pacote nos filtros |
| A-25 | ✅ | Nomes divergentes Dev × UX (resolvido na consolidação: `/dev/catalog`, `EXPO_PUBLIC_DEV_TOOLS`, `src/app`, Inter 400/600/700, `.env` na raiz) | Rota `/dev/catalog` (Dev) × `dev/catalogo` (UX); `EXPO_PUBLIC_DEV_ROUTES` × `EXPO_PUBLIC_DEV_TOOLS`; `src/app/` × `app/`; Inter com peso 500 (Dev) × só 400/600/700 (UX); `.env.example` por app com `PORT` (Dev) × `.env.example` na raiz com `API_PORT` (DevOps) | Dev + UX + DevOps | Padronizar antes do scaffold (sugestão: `/dev/catalog`, `EXPO_PUBLIC_DEV_TOOLS`, `src/app`, pesos do UX, `.env` na raiz) |
| A-26 | 🟡 | Sentry: Fase 0 × Fase 6 (D4) | A especificação diz "desde o início" e lista Sentry na Fase 6 | PO | Opção mínima do Dev na Fase 0 (sem DSN, nada é enviado); teste PERM-17 do `beforeSend` só na Fase 6 |
| A-27 | 🟡 | Testabilidade do tempo | A arquitetura usa `now()` do Postgres em `expires_at`/janela. Sem relógio injetável, os testes de borda (72 h exatas, 120 s) dependem de `sleep` ou de editar linhas | Arquiteto + Dev | `Clock` injetável e TTLs por config (seção 3.3) como requisito de arquitetura |
| A-28 | 🟡 | Senha: limite máximo e Unicode | Não há tamanho máximo (DoS no argon2) nem normalização (senha com acento digitada no iOS e no Android pode virar bytes diferentes) | Arquiteto | Máximo de 128 caracteres e NFC antes do hash (AUTH-02) |
| A-29 | 🟢 | Lista de @ reservados e formato | Não existe a lista; a regex aceita `...` e `___` | PO + Dev | Lista em `packages/shared` (AUTH-04); exigir ao menos uma letra ou dígito |
| A-30 | 🟢 | O que conta em "publicações" | Não definido se soma fotos, textos e reels | PO | Soma dos três tipos publicados |
| A-31 | 🟢 | Busca sem rate limit e sem paginação | Sem limite, a busca permite varrer todos os criadores; com 20 resultados fixos, o 21º criador com o mesmo prefixo nunca aparece | Arquiteto | Rate limit de busca (ex.: 60/min) e aceitar o teto de 20 (o usuário refina o prefixo) |
| A-32 | 🟡 | Seletor "NFC / Bluetooth" e QR sem tela (D3) | O protótipo não tem QR em nenhuma tela, e a especificação exige o QR como plano B. "NFC" sem NFC engana o usuário | PO | "Bluetooth / QR code" (D-UX1) |
| A-33 | 🟡 | QR cruzado (D7) | ADR 0003 e UX recomendam que B leia o QR de A; a especificação não diz | PO | QR cruzado (mantém a garantia de presença); testes PROX-24 e MAN-QR-01 seguem a decisão |
| A-34 | 🟢 | Cooldown depois da recusa | 1 h de A para B. Não se sabe se B→A também fica bloqueado | Arquiteto | B→A permitido (quem recusou pode mudar de ideia) |
| A-35 | 🟢 | Fuso de "Hoje" e "Esta semana" | O bucket de seguidores usa America/Sao_Paulo; o agrupamento no app usa o fuso do aparelho | Arquiteto + UX | Agrupar no app pelo fuso do aparelho e aceitar a pequena divergência; NOT-03 documenta |
| A-36 | 🟡 | Piso de SO suportado | Nenhum documento define iOS e Android mínimos; o caminho de permissão BLE muda entre Android ≤ 11 e 12+ | PO + Dev | Adotar o mínimo do Expo SDK 58 (confirmar na Fase 0) e testar Android 10/11 só se o piso incluir |
| A-37 | 🟡 | Denunciar e bloquear (D5) | Exigido pela App Store; bloqueio mexe no `AccessPolicyService` e nos testes de permissão | PO | Decidir antes da Fase 3; se entrar, os casos de bloqueio entram na suíte PERM |
| A-38 | 🟡 | Sem "esqueci a senha" nem verificação de e-mail (D6) | Quem esquece a senha perde a conta e as conexões presenciais; sem verificação, alguém pode cadastrar o e-mail de outra pessoa e impedir o dono de se cadastrar | PO | Incluir os dois antes do lançamento (não necessariamente na Fase 1) |
| A-39 | 🟢 | Criador vê quem curtiu e comentou | p-21 mostra "marinac curtiu sua foto" ao criador. Seguidores são anônimos, mas curtidas e comentários identificam a pessoa | PO | Aceitar (coerente com "funcionam como nas redes comuns") e deixar explícito |
| A-40 | 🟢 | "Valor configurável" da janela de 72 h | Não diz por quem. A arquitetura usa env (operador), não preferência do usuário | PO | Env do servidor (FEED-03b) |
| A-41 | 🟢 | "Você está em dia": círculo cheio (especificação) × contorno (p-08); ícone ativo do Conectar azul (p-10) × preto (especificação); prévia do Criar quadrada (p-18) × 4:5 | Divergências visuais já levantadas pelo UX (D-UX20, D-UX8, D-UX6) | PO | Seguir a recomendação do UX; o teste de componente fixa o que for decidido |
| A-42 | 🟢 | Proteção da `main` | Repositório privado no GitHub Free não exige checks; "CI verde" no DoD depende de disciplina | PO | GitHub Pro (US$ 4/mês) ou repositório público; senão, registrar o link do CI verde no PR |
| A-43 | 🟢 | Distância "a ~1 m" (D13), login por usuário (D14), itens de demo (D15) | Divergências do protótipo já mapeadas | PO | Faixas, só e-mail, demos fora da UI (só `/dev` em dev). PROX-30 testa a ausência em produção |

---

## 12. Perguntas para o PO

1. **iOS (A-02)**: aceita fechar as Fases 0 a 3 como "aprovada com pendência iOS" até a conta Apple existir? Quando a conta será criada?
2. **Aparelhos (A-03, A-36)**: quais iPhones e Androids você tem? Consegue 2 iPhones e 2 Androids para a Fase 4? Qual o SO mínimo que quer suportar?
3. **Busca (A-04)**: aceita a dica genérica em vez de detectar o @ de conta pessoal?
4. **Criador (A-06)**: o criador pode responder e apagar comentários nos próprios posts? Pode curtir?
5. **Comentários (A-07/D11)**: comentários visíveis a quem vê o post, sabendo que isso expõe o @ de quem comenta?
6. **280 caracteres (A-09)**: emoji composto conta como vários caracteres (code points) ou como 1 (grafema)?
7. **Exclusão de conta (A-13, A-14, A-15)**: comentários e curtidas somem na hora? O @ pode ser reutilizado? Pedir a senha para excluir?
8. **Seed na Fase 2 (A-08)**: aceita que o feed da Fase 2 seja demonstrado com dados de seed?
9. **Vídeo com GPS (A-21)**: aceita que a remoção de localização dos reels só seja verificada depois do `apply`?
10. **Componentes base (A-23)**: aceita 11 componentes na Fase 0 e os compostos nas fases que os usam?
11. **Denunciar/bloquear e esqueci a senha (A-37, A-38)**: entram na v1? Em qual fase?
