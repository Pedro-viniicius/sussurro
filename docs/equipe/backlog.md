# Backlog do Sussurro v1 (rascunho)

> Autor: Dev. Data: 2026-10-29. Status: rascunho para o QA detalhar os critérios de aceite e para o PO priorizar.
> Fontes: `briefing.md` (§8 fases), `arquitetura.md`, ADRs 0001 a 0011, `fase-0-plano.md`.

**Legenda**
- Estimativa em pontos de Fibonacci (1, 2, 3, 5, 8, 13). Referência: 1 ponto ≈ 2 horas de um dev, incluindo testes (calibrado com a estimativa em horas do `fase-0-plano.md`: 35 pontos de Dev ≈ 74 h). É uma ordem de grandeza para comparar fases, não um prazo.
- Especialização: **F** = front (app/ui), **B** = back (API/worker/db), **FS** = full stack, **D** = DevOps.
- 🔶 **PO: Dn** = depende de decisão pendente do PO (numeração do `HANDOFF.md` §4). **PO: novo** = decisão levantada neste backlog.
- CA = critério de aceite essencial (o QA detalha depois).
- **Critérios de aceite do QA**: ficam numa seção depois de cada tabela, no formato Dado/Quando/Então. **(completo)** = todos os cenários, incluindo negativos e de borda; **(resumido)** = cenário principal e bordas mais importantes. Os códigos entre colchetes (`[PERM-10]`, `[F0-API-03]`) apontam para os casos e o checklist de `testes.md`. As tabelas e as estimativas do Dev não foram alteradas.
- Todo épico termina com o critério de pronto da especificação: testes passam, regras de permissão verificadas no servidor, app roda em iOS e Android (dev build), README atualizado.

## Resumo

| Épico | Fase | Pontos | Histórias com decisão pendente |
|---|---|---|---|
| E0 Fundação | 0 | 44 (35 de Dev + 9 de DevOps) | 0.2, 0.3, 0.9, 0.10 |
| E1 Autenticação e perfil | 1 | 39 (+8 se 1.10 for aprovada) | 1.2, 1.10 |
| E2 Publicações, feed, curtidas e comentários | 2 | 56 | 2.5, 2.8 |
| E3 Criadores, busca e seguir | 3 | 32 | 3.2 |
| E4 Conexão presencial | 4 | 63 | 4.1, 4.3, 4.4, 4.7, 4.9, 4.11 |
| E5 Reels | 5 | 30 | 5.3 |
| E6 Notificações, push e Sentry | 6 | 27 | 6.7 |
| E7 Terraform e deploy | 7 | 36 | – |
| EX Pendentes sem fase | ? | 26 | todas |
| **Total (sem EX e sem 1.10)** | | **327** (≈ 650 h de um dev) | |

---

## E0: Fundação (Fase 0)

Detalhes em `fase-0-plano.md`.

| # | História | Tarefas técnicas | Esp. | Pts | Depende de | CA essencial |
|---|---|---|---|---|---|---|
| 0.1 | Como dev, quero um monorepo pnpm/Turborepo com scripts padronizados, para instalar, lintar, testar e buildar com um comando | raiz, `packages/config`, turbo pipeline, Prettier, ESLint, TS 6.0 strict | FS | 5 | pnpm instalado | `pnpm check` verde e segunda execução do turbo em cache |
| 0.2 | Como dev, quero subir Postgres, Redis e emuladores S3/SQS localmente, para rodar tudo na minha máquina 🔶 **PO: D2** | docker-compose (`infra.md`) | D | 3 | WSL2 instalado | `docker compose up` deixa os serviços saudáveis |
| 0.3 | Como dev, quero CI básico em todo PR, para não quebrar a `main` 🔶 **PO: D16** | workflow com lint, typecheck, test, test:e2e com services, gitleaks (`infra.md`) | D | 3 | 0.1, repositório remoto | PR com erro de lint fica vermelho |
| 0.4 | Como operador, quero `/health` e `/health/ready`, para saber se a API e suas dependências estão de pé | bootstrap Nest 12 ESM, config Zod, logger, filtro de erros, checks Postgres/Redis, Vitest + SWC | B | 5 | 0.1, 0.6 | ready = 200 com tudo no ar, 503 com Redis fora |
| 0.5 | Como dev, quero o esqueleto do worker, para receber os consumidores de fila na Fase 2 | application context, config, logger, shutdown, teste | B | 2 | 0.4 | sobe e desliga graciosamente |
| 0.6 | Como dev, quero `packages/shared` e `packages/db` configurados, para compartilhar contratos e acessar o banco | schemas de erro e health, build dual, `createDb`, drizzle config (sem tabelas) | B | 3 | 0.1 | teste de integração faz `select 1` |
| 0.7 | Como PO, quero o app abrindo num dev build com a marca, para validar no meu celular | Expo 58 + Router, `app.config.ts`, `eas.json`, fontes, ícone/splash do `<Logo>`, Jest + RNTL, smoke test ADR 0001 | F | 5 | 0.1, contas Expo/Apple | abre no Android e no iPhone com fontes e marca corretas |
| 0.8 | Como PO e designer, quero `theme.ts`, `<Logo>` e os componentes base num catálogo só de dev, para revisar a fidelidade visual | tokens, Logo, Icon, Avatar, Button, Input, TopTabs, BottomTabBar, Toast, EmptyState, CaughtUp, StatsRow, rota `/dev/catalog` | F | 13 | 0.7, `ux.md` | todos os componentes e estados no catálogo; rota bloqueada fora de dev |
| 0.9 | Como dev, quero o Sentry inicializado quando houver DSN, para capturar erros desde o início 🔶 **PO: D4** | SDK no app e na API/worker, ativado só por env | FS | 2 | 0.4, 0.7 | sem DSN não faz nada; com DSN, erro 500 aparece no Sentry |
| 0.10 | Como dev, quero validar os emuladores S3/SQS, para garantir que o pipeline de mídia vai funcionar localmente 🔶 **PO: D2** | spike ADR 0010: PUT pré-assinado, HEAD, DeleteObject, DLQ, visibility timeout | D+B | 3 | 0.2 | relatório do spike com resultado de cada operação |

### Critérios de aceite (QA): E0

**0.1 Monorepo e scripts (completo)**
- **CA1** Dado uma cópia limpa do repositório com Node 26.13 e o pnpm fixado, quando rodo `pnpm install --frozen-lockfile`, então o comando termina com código 0, sem peer dependency não resolvido. `[F0-GATE-01]`
- **CA2** Dado as dependências instaladas, quando rodo `pnpm check`, então format, lint (0 erros e 0 avisos), typecheck e testes unitários passam em todos os pacotes. `[F0-Q-01..04]`
- **CA3** Dado que nada mudou, quando rodo `pnpm turbo run lint typecheck test` pela segunda vez, então a execução sai do cache (`FULL TURBO`). `[F0-Q-06]`
- **CA4** Dado um arquivo com formatação fora do padrão ou um erro de lint, quando rodo `pnpm check`, então o comando falha e aponta o arquivo.
- **CA5** Dado um Node de outro major (ex.: 24), quando rodo `pnpm install`, então a instalação falha com mensagem de `engines` (engine-strict).
- **CA6** Dado um pnpm global de versão diferente da fixada no `packageManager`, quando rodo um script na raiz, então é usada a versão fixada ou o comando falha com mensagem clara (nunca roda silenciosamente com outra versão).
- **CA7** Dado o `.gitattributes`, quando faço checkout no Windows, então os arquivos de texto ficam com LF (exceto `.ps1/.cmd/.bat`).

**0.2 docker-compose (completo)**
- **CA1** Dado WSL2 e Docker Desktop funcionando, quando rodo `docker compose up -d --wait`, então o comando termina com código 0 e `docker compose ps -a` mostra `postgres`, `valkey` e `seaweedfs` saudáveis, `elasticmq` no ar e `s3-init` com saída 0. `[F0-DC-01/02]`
- **CA2** Dado o compose no ar, quando verifico as portas, então Postgres, Valkey e ElasticMQ escutam só em `127.0.0.1` e só o S3 (8333) fica na LAN. `[F0-DC-05]`
- **CA3** Dado o bucket já criado, quando derrubo e subo o compose de novo, então tudo sobe sem erro e os dados do volume continuam lá. `[F0-DC-06]`
- **CA4** Dado o repositório, quando procuro segredos, então só existe `.env.example` com valores fictícios e o `.env` está no `.gitignore`.
- **CA5** Dado a opção LocalStack (se o PO escolher em D2) sem `LOCALSTACK_AUTH_TOKEN`, quando subo o compose, então a falha cita a variável que falta.

**0.3 CI básico (completo)**
- **CA1** Dado um PR limpo para `main`, quando o CI roda, então os jobs `secrets`, `quality`, `test` e `build` ficam verdes. `[F0-CI-01]`
- **CA2** Dado um PR com erro de lint, teste quebrado ou segredo falso, quando o CI roda, então o job correspondente fica vermelho. `[F0-CI-02..04]`
- **CA3** Dado o job `test`, quando ele roda, então executa `pnpm test` **e** `pnpm test:e2e` contra Postgres 18 e Valkey como services. `[F0-CI-05]`
- **CA4** Dado dois pushes seguidos no mesmo PR, quando o segundo começa, então o primeiro é cancelado.
- **CA5** Dado o workflow, quando inspeciono as permissões, então são `contents: read` e as actions estão fixadas por SHA.

**0.4 `/health` e `/health/ready` (completo)**
- **CA1** Dado a API no ar, quando chamo `GET /health` sem token, então recebo 200 `{"status":"ok"}`, mesmo com Postgres ou Redis fora (liveness não depende deles). `[F0-API-01]`
- **CA2** Dado Postgres e Redis no ar, quando chamo `GET /health/ready`, então recebo 200 com os dois `up`. `[F0-API-02]`
- **CA3** Dado o Redis parado, quando chamo `GET /health/ready`, então recebo 503 com `redis.status = "down"` em até ~1,5 s; dado que o Redis volta, quando chamo de novo, então recebo 200 sem reiniciar a API. `[F0-API-03]`
- **CA4** Dado o Postgres parado, quando chamo `GET /health/ready`, então recebo 503 com `postgres.status = "down"`. `[F0-API-04]`
- **CA5** Dado uma rota inexistente, quando chamo `/v1/nao-existe`, então recebo 404 `{"code":"NOT_FOUND","message":...}` sem stack. `[F0-API-05]`
- **CA6** Dado o `.env` sem `DATABASE_URL`, quando inicio a API, então o processo encerra com mensagem citando a variável. `[F0-API-06]`
- **CA7** Dado uma chamada com `Authorization`, quando olho o log, então o valor do header não aparece e o `/health` não gera log. `[F0-API-08]`

**0.5 Worker (completo)**
- **CA1** Dado o worker iniciado, quando envio Ctrl+C (SIGINT/SIGTERM), então ele registra o desligamento, fecha conexões e sai com código 0. `[F0-API-07]`
- **CA2** Dado uma variável obrigatória ausente, quando inicio o worker, então ele encerra no boot citando a variável.
- **CA3** Dado o teste `worker.module.spec.ts`, quando rodo `pnpm test`, então o módulo compila e o desligamento fecha os recursos.

**0.6 `packages/shared` e `packages/db` (completo)**
- **CA1** Dado o `ErrorResponseSchema`, quando valido `{code, message}` e variações inválidas (sem `code`, `code` fora da lista), então as válidas passam e as inválidas falham.
- **CA2** Dado o `shared` buildado, quando a API importa em Node ESM e o app importa pelo Metro, então os dois resolvem (`dist` no Node, fonte no Metro). `[F0-GATE-03, F0-GATE-06]`
- **CA3** Dado o compose no ar, quando rodo o teste de integração do `db`, então `select 1` funciona; dado uma URL inválida, então `createDb` falha com mensagem clara. `[F0-Q-05]`
- **CA4** Dado um import de `@sussurro/db` no app ou de React/Nest no `shared`, quando rodo `pnpm lint`, então o lint falha.

**0.7 App em dev build com a marca (completo)**
- **CA1** Dado as contas Expo e Apple, quando rodo `eas build --profile development` para Android e iOS, então os dois builds terminam e instalam em aparelhos físicos. Sem conta Apple, o iOS fica como pendência aceita pelo PO. `[F0-APP-01/02]`
- **CA2** Dado o dev build e o Metro no PC, quando abro o app, então vejo o ícone e o splash da marca, as fontes Inter e Bricolage Grotesque carregadas e a tela inicial com lockup e tagline "A rede social sem algoritmo.". `[F0-APP-03]`
- **CA3** Dado o aparelho em paisagem, quando abro o app, então a interface continua em retrato.
- **CA4** Dado as variantes `development`, `preview` e `production`, quando rodo o teste de config, então só `development` libera HTTP em claro (Android) e rede local (ATS), e os bundle ids são diferentes por variante. `[F0-APP-05]`
- **CA5** Dado o portão do ADR 0001, quando rodo `expo-doctor`, `expo export` e `expo prebuild`, então nenhum falha; o deployment target iOS e o `minSdkVersion` ficam registrados no README. `[F0-GATE-02..04]`

**0.8 Tema, Logo, componentes base e catálogo (completo)**
- **CA1** Dado o `theme.ts`, quando rodo os testes, então os 9 hex do briefing são exatamente os da especificação e as extensões são as do `ux.md` §6.2; trocar um valor faz o teste falhar. `[F0-Q-07]`
- **CA2** Dado o `<Logo>`, quando renderizo `mark` e `lockup`, então os paths, o `viewBox 0 0 64 64`, o `stroke-width 8` e as cores são os da especificação; com `tone="onBrand"`, os arcos são branco e `#B3D1FF` e o ponto é branco; o wordmark está em minúsculas com Bricolage 800.
- **CA3** Dado cada componente base (Logo, Icon, Avatar, Button, Input, TopTabs, BottomTabBar, Toast, EmptyState, CaughtUp, StatsRow), quando rodo os testes, então há teste de render para cada variante e estado, e todo elemento tocável é encontrado por `getByRole` com rótulo em português.
- **CA4** Dado o Avatar sem foto, quando renderizo o mesmo `seed` duas vezes, então a cor pastel é a mesma (FNV-1a, snapshot de 10 ids); "Érica Lima" gera "ÉL"; nome de uma palavra gera 1 letra; sem nome usa o handle.
- **CA5** Dado o Button desabilitado ou em `loading`, quando toco, então `onPress` não é chamado e `accessibilityState` reflete o estado.
- **CA6** Dado o StatsRow, quando passo 8903, 12400 e 1200000, então mostra "8.903", "12,4 mil" e "1,2 mi"; 1 publicação no singular e 2 no plural.
- **CA7** Dado o CaughtUp com `windowHours` 72, 24 e 36, quando renderizo, então os textos são "últimos 3 dias", "último dia" e "últimas 36 horas".
- **CA8** Dado a BottomTabBar, quando renderizo `personal` e `creator`, então a ordem é Início, Pesquisar, Criar, Conectar, Perfil e Notificações, Criar, Perfil, com rótulos acessíveis.
- **CA9** Dado o catálogo em dev, quando abro a rota, então todos os componentes aparecem com variantes e estados; o teste de smoke renderiza o catálogo inteiro sem erro. `[F0-APP-04]`
- **CA10** Dado um build `preview`/`production`, quando abro a rota do catálogo, então sou redirecionado para `/`. `[F0-APP-05]`
- **CA11** Dado a fonte do sistema em 200% e Reduzir movimento ligado, quando abro o catálogo, então nenhum texto é cortado e as animações param. `[F0-APP-06]`

**0.9 Sentry mínimo (completo, se D4 = Fase 0)**
- **CA1** Dado nenhum DSN configurado, quando a API, o worker e o app sobem, então o SDK não é inicializado e nenhuma requisição sai para o Sentry.
- **CA2** Dado um DSN de teste, quando forço um erro 500, então o evento chega ao Sentry; dado um erro 4xx, então nada é enviado.
- **CA3** Dado o SDK inicializado, quando inspeciono a config, então `sendDefaultPii` é `false` e o evento não traz `Authorization` nem corpo de requisição.

**0.10 Spike dos emuladores (completo)**
- **CA1** Dado o compose no ar, quando rodo o spike, então o relatório traz OK/FALHA para: PUT pré-assinado feito **do celular** via `S3_PUBLIC_ENDPOINT_URL`, HEAD, GET pré-assinado, DeleteObject, envio/recebimento SQS, visibility timeout e DLQ após 3 recebimentos. `[F0-DC-07]`
- **CA2** Dado um PUT com corpo maior que o `Content-Length` assinado, quando envio, então o emulador recusa. Se aceitar, o relatório registra a divergência e os testes MID-03 viram só teste de contrato.
- **CA3** Dado uma URL pré-assinada vencida, quando faço o PUT, então o emulador recusa (mesma regra de divergência, MID-07).
- **CA4** Dado qualquer FALHA essencial, quando o spike termina, então a decisão (ajustar, LocalStack ou aceitar a divergência) é levada ao PO antes da Fase 2.

---

## E1: Autenticação, cadastro e perfil próprio (Fase 1)

| # | História | Tarefas técnicas | Esp. | Pts | Depende de | CA essencial |
|---|---|---|---|---|---|---|
| 1.1 | Como pessoa nova, quero me cadastrar com e-mail, senha, @, nome e tipo de conta, para começar a usar o Sussurro | tabelas `users` e `refresh_tokens`, enums, trigger de tipo imutável, primeira migration; argon2id; `POST /auth/register`; rate limit 5/h por IP; tela de cadastro com lista de opções Pessoal/Criador | FS | 8 | E0 | @ único e minúsculo; tipo gravado; senha nunca volta na resposta |
| 1.2 | Como pessoa cadastrada, quero entrar com e-mail e senha, para acessar minha conta 🔶 **PO: D14** | `POST /auth/login`, JWT 15 min, refresh opaco, rate limit; tela de login | FS | 5 | 1.1 | erro genérico para credencial inválida; 6ª tentativa no minuto bloqueada |
| 1.3 | Como pessoa logada, quero continuar logada sem digitar a senha de novo, para não ser interrompida | `POST /auth/refresh` com rotação e detecção de reuso (20 s de graça); secure-store; cliente HTTP com single-flight | FS | 5 | 1.2 | reuso após 20 s revoga a família; refresh concorrente não desloga |
| 1.4 | Como pessoa logada, quero sair deste aparelho ou de todos, para proteger minha conta | `POST /auth/logout`, `POST /auth/logout-all` | FS | 2 | 1.3 | token revogado não renova |
| 1.5 | Como pessoa, quero ver meu perfil com meus números, para acompanhar minha conta | `GET /me`, `GET /users/:handle` (regras de visibilidade §7), contadores; `ProfileHeader`; tela de perfil com abas vazias | FS | 5 | 1.2 | perfil pessoal de não conexão = 404 |
| 1.6 | Como pessoa, quero editar nome e bio, para me apresentar | `PATCH /me`; tela Editar perfil | FS | 3 | 1.5 | limites de nome (60) e bio (150) validados no servidor |
| 1.7 | Como pessoa, quero excluir minha conta, para sair do app com meus dados apagados (exigido pela App Store) | `DELETE /me` com `deleted_at`, revogação de sessões, job de hard delete em até 30 dias | FS | 5 | 1.4 | conta excluída some da busca e de perfis na hora; login falha |
| 1.8 | Como dev, quero respostas filtradas pelo schema Zod declarado, para que nenhuma rota vaze campos (ADR 0004) | interceptor de resposta, decorator de schema, falha fechada sem schema, guard `@RequireAccountType` | B | 3 | 1.1 | rota sem schema responde 500; campo extra não sai |
| 1.9 | Como pessoa ou criador, quero a navegação certa para meu tipo de conta, para ver só o que posso usar | layouts do Expo Router por tipo, barras inferiores (pessoal: 5 ícones; criador: 3), telas ainda vazias com `EmptyState` | F | 3 | 1.2 | criador nunca vê Início, Pesquisar nem Conectar |
| 1.10 | Como pessoa que esqueceu a senha, quero redefini-la por e-mail, para recuperar o acesso 🔶 **PO: D6** | serviço de e-mail (SES), token de redefinição, telas | FS | 8 | 1.2, decisão | **pendente**; fora da contagem se o PO não aprovar |

### Critérios de aceite (QA): E1

**1.1 Cadastro (completo)**
- **CA1** Dado e-mail, senha, @, nome e tipo válidos, quando envio `POST /auth/register`, então recebo 201, a conta é criada com o tipo escolhido, e-mail e @ ficam em minúsculas e a resposta não contém senha nem hash. `[AUTH-01]`
- **CA2** Dado uma senha com 7 caracteres, da lista de senhas comuns ou acima do máximo (proposta: 128), quando me cadastro, então recebo 400 `WEAK_PASSWORD`/`VALIDATION_ERROR` e o argon2 nem roda para a senha longa demais; dado 8 caracteres fora da lista, então o cadastro passa. `[AUTH-02]`
- **CA3** Dado um e-mail já usado, inclusive com maiúsculas ou espaços (`Ana@X.com `), quando me cadastro, então recebo 409 e o app mostra "e-mail em uso" no campo. `[AUTH-03]`
- **CA4** Dado um @ já usado, reservado (`admin`, `sussurro`, `suporte`…), com 2 ou 31 caracteres, com caractere fora de `[a-z0-9._]` ou só com pontos/underscores, quando me cadastro, então recebo 409 (em uso) ou 400 (formato/reservado). `[AUTH-04]`
- **CA5** Dado `accountType` fora do enum, quando me cadastro, então recebo 400; dado `accountType` ausente, então vale a regra decidida (padrão `personal` ou 400). `[AUTH-05]`
- **CA6** Dado uma conta criada, quando tento mudar `account_type` direto no banco, então o trigger recusa. `[PERM-06]`
- **CA7** Dado 5 cadastros na última hora pelo mesmo IP, quando faço o 6º, então recebo 429 e o app mostra "Muitos cadastros desta rede. Tente mais tarde." `[AUTH-07]`
- **CA8** Dado a tela de cadastro, quando escolho Criador, então vejo o aviso "Não dá para trocar o tipo de conta depois."; "Pessoal" vem marcado por padrão; o @ é convertido para minúsculas ao digitar.
- **CA9** Dado uma senha com acento digitada em NFD (comum ao colar texto), quando me cadastro e depois entro digitando em NFC, então o login funciona. `[AUTH-02]`

**1.2 Login (completo)** 🔶 D14
- **CA1** Dado e-mail e senha corretos, quando entro, então recebo access token (15 min) e refresh token, e o app vai para a navegação do meu tipo de conta. `[AUTH-06]`
- **CA2** Dado senha errada ou e-mail inexistente, quando entro, então recebo o mesmo 401 com a mesma mensagem ("E-mail ou senha incorretos.") e tempo de resposta parecido. `[AUTH-06]`
- **CA3** Dado 5 tentativas no último minuto para o mesmo IP+e-mail, quando faço a 6ª, então recebo 429 "Muitas tentativas. Tente de novo em 1 minuto."; dado 20 por IP, a 21ª também recebe 429. `[AUTH-07]`
- **CA4** Dado um e-mail com maiúsculas/espaços, quando entro, então funciona igual ao e-mail normalizado.
- **CA5** Dado uma conta excluída, quando entro com as credenciais antigas, então recebo o mesmo 401 de credencial inválida. `[CONTA-01]`
- **CA6** Dado a tela Entrar, quando abro, então o campo diz "E-mail" (se D14 = só e-mail) e não existe "Entrar na conta de criador (demo)". `[A-43]`

**1.3 Sessão contínua (refresh rotativo) (completo)**
- **CA1** Dado um refresh R1 válido, quando chamo `/auth/refresh`, então recebo R2 e um novo access token, e R1 fica marcado como usado. `[AUTH-08]`
- **CA2** Dado R1 já usado, quando o reapresento em até 20 s, então recebo um novo par e o sucessor R2 é revogado (retry de rede). `[AUTH-08]`
- **CA3** Dado R1 já usado, quando o reapresento depois de 20 s, então recebo 401 e **todos** os tokens da família são revogados; as famílias de outros aparelhos continuam válidas. `[AUTH-08]`
- **CA4** Dado um refresh vencido (30 dias), revogado ou de conta excluída, quando chamo refresh, então recebo 401. `[AUTH-09]`
- **CA5** Dado 5 requisições do app que recebem 401 ao mesmo tempo, quando o cliente HTTP reage, então faz **uma** chamada de refresh e repete as 5. `[AUTH-10]`
- **CA6** Dado o refresh recusado, quando o app recebe 401, então volta para Entrar com o Toast "Sua sessão expirou. Entre de novo." e mantém o e-mail digitado. `[AUTH-10]`
- **CA7** Dado o app fechado à força, quando reabro, então continuo logado; o access token nunca é gravado em disco. `[AUTH-13]`
- **CA8** Dado um JWT expirado, com assinatura de outro segredo, `alg: none`, `kid` desconhecido ou `acct` alterado, quando chamo uma rota protegida, então recebo 401. `[AUTH-11]`

**1.4 Sair (completo)**
- **CA1** Dado uma sessão ativa, quando chamo `/auth/logout`, então a família do aparelho é revogada e o refresh dela recebe 401. `[AUTH-12]`
- **CA2** Dado sessões em dois aparelhos, quando chamo `/auth/logout-all`, então todas as famílias são revogadas. `[AUTH-12]`
- **CA3** Dado o logout, quando uso o access token antigo dentro de 15 min, então ele ainda funciona (comportamento documentado). `[AUTH-12]`
- **CA4** Dado o ícone Sair no perfil, quando toco, então o app pede confirmação ("Sair da conta?") antes de sair. (D-UX16)

**1.5 Perfil próprio e de outros (completo)**
- **CA1** Dado uma pessoa logada, quando abro meu perfil, então vejo @, nome, tipo, bio e os números publicações, conexões e criadores (criador: publicações e seguidores), todos 0 numa conta nova. `[CNT-01]`
- **CA2** Dado o perfil pessoal de B, quando A (não conexão), um criador ou alguém sem conexão chama `GET /users/:handle`, então recebe 404 com corpo **idêntico** ao de um @ inexistente. `[PERM-13]`
- **CA3** Dado o perfil de uma conta excluída, quando qualquer pessoa o consulta, então recebe 404. `[PERM-13]`
- **CA4** Dado qualquer perfil, quando inspeciono a resposta, então só há números em `counts` (nenhuma lista, nenhum id de relacionamento); o schema está no snapshot. `[PERM-11]`
- **CA5** Dado uma rota sem schema de resposta declarado, quando chamada, então responde 500 (falha fechada). `[PERM-12]`
- **CA6** Dado o meu perfil pessoal, quando o vejo, então aparece a nota "Só os números são públicos…" e os números de conexões e criadores são tocáveis (listas só minhas, a partir das Fases 3/4).
- **CA7** Dado qualquer rota protegida, quando chamo sem token, então recebo 401. `[PERM-18]`

**1.6 Editar nome e bio (completo)**
- **CA1** Dado nome com 1 a 60 caracteres e bio com até 150, quando salvo, então os valores mudam e aparecem no perfil.
- **CA2** Dado nome vazio, só espaços ou com 61 caracteres, ou bio com 151 (contados pela mesma regra do TXT-01), quando salvo, então recebo 400 com erro no campo. `[TXT-04]`
- **CA3** Dado `PATCH /me` com `accountType`, `handle`, `email` ou `id`, quando envio, então recebo 400 e nada muda. `[PERM-07]`
- **CA4** Dado a tela Editar perfil, quando abro, então @ e tipo de conta aparecem somente leitura e "Concluir" fica desabilitado sem mudanças.

**1.7 Excluir conta (completo)** 🔶 D-UX18
- **CA1** Dado a senha correta (se D-UX18 = sim), quando confirmo a exclusão, então recebo 204, todas as sessões são revogadas, volto para Entrar com o Toast "Sua conta foi excluída." e o login seguinte falha. `[CONTA-01]`
- **CA2** Dado a senha errada, quando confirmo, então recebo 401 e nada muda. `[CONTA-01]`
- **CA3** Dado a conta excluída, quando qualquer pessoa consulta o perfil, então recebe 404 **na hora**; nas fases seguintes, os posts somem do feed, a conta some da busca e os contadores dos outros caem na hora. `[CONTA-02]`
- **CA4** Dado um access token da conta excluída ainda dentro dos 15 min, quando o uso, então recebo 401. `[CONTA-07]`
- **CA5** Dado o job de hard delete, quando passa o prazo (até 30 dias), então as linhas são apagadas e nenhum contador fica inconsistente. `[CONTA-05]`
- **CA6** Dado o @ de uma conta excluída, quando alguém tenta se cadastrar com ele, então vale a regra decidida pelo PO (proposta: recusado). `[CONTA-06]`

**1.8 Respostas filtradas por schema e guard de tipo (completo)**
- **CA1** Dado um service que devolve um campo a mais (ex.: `passwordHash`), quando a rota responde, então o campo não sai. `[PERM-12]`
- **CA2** Dado uma rota sem schema declarado, quando chamada, então responde 500 `INTERNAL_ERROR` e o erro vai para o log. `[PERM-12]`
- **CA3** Dado uma rota com `@RequireAccountType('personal')`, quando um criador a chama, então recebe 403 `ACCOUNT_TYPE_NOT_ALLOWED`. `[PERM-05]`
- **CA4** Dado um erro de FK composta do banco, quando ele chega ao filtro, então vira 403 (nunca 500).
- **CA5** Dado o log de uma requisição com `password` no corpo e `Authorization` no header, quando o inspeciono, então nenhum dos dois aparece. `[PERM-17]`

**1.9 Navegação por tipo de conta (completo)**
- **CA1** Dado uma conta pessoal, quando entro, então a barra tem Início, Pesquisar, Criar, Conectar e Perfil, nessa ordem.
- **CA2** Dado uma conta de criador, quando entro, então a barra tem Notificações, Criar e Perfil, a aba inicial é Perfil (D-UX17) e não existe forma de abrir Início, Pesquisar ou Conectar (inclusive por deep link).
- **CA3** Dado as telas ainda sem conteúdo, quando abro, então vejo o `EmptyState` correspondente.
- **CA4** Dado um deep link para uma rota do outro tipo de conta, quando abro, então sou redirecionado para a minha aba inicial.

**1.10 Esqueci a senha (resumido, pendente D6)**
- **CA1** Dado um e-mail cadastrado ou não, quando peço redefinição, então a resposta é sempre a mesma (sem revelar se o e-mail existe).
- **CA2** Dado o link de redefinição, quando uso depois de vencido ou pela segunda vez, então é recusado; ao redefinir, todas as sessões são revogadas.

---

## E2: Publicações de foto e texto, feed, curtidas e comentários (Fase 2)

| # | História | Tarefas técnicas | Esp. | Pts | Depende de | CA essencial |
|---|---|---|---|---|---|---|
| 2.1 | Como pessoa ou criador, quero publicar um texto de até 280 caracteres, para compartilhar uma ideia | tabela `posts`; `POST /posts` tipo text; tela Criar modo texto com contador x/280 e pílula FOTO/TEXTO/REEL | FS | 3 | E1 | 281 caracteres (code points) = 400 |
| 2.2 | Como pessoa ou criador, quero publicar de 1 a 4 fotos com legenda, para compartilhar momentos | `post_media`; `POST /posts/drafts` (URLs PUT pré-assinadas), `POST /posts/:id/publish` com HEAD; HEIC→JPEG e redução no app; grade de seleção numerada; estado "publicando" | FS | 8 | 2.1, 0.10 | 5ª foto rejeitada; arquivo maior que o declarado rejeitado pela assinatura |
| 2.3 | Como pessoa, quero que minhas fotos sejam publicadas sem a localização, para proteger minha privacidade | consumidor `media-jobs` no worker, magic bytes, `sharp` (rotate, strip, full/thumb), DLQ, transição para `published` | B | 8 | 2.2 | fixture com GPS sai sem nenhum metadado |
| 2.4 | Como pessoa ou criador, quero colocar uma foto de perfil, para ser reconhecida | `POST /me/avatar/upload-url`, `PUT /me/avatar`, processamento reaproveitando 2.3 | FS | 3 | 2.3 | avatar aparece no perfil e no `Avatar` |
| 2.5 | Como pessoa, quero ver o feed em ordem cronológica por aba e terminar em "Você está em dia", para não rolar sem fim 🔶 **PO: D9** (meus posts no feed?) | `GET /feed` com CTE + LATERAL, janela 72 h no cursor, URLs assinadas do CloudFront (assinador local em dev); telas Fotos/Textos com `CaughtUp` | FS | 8 | 2.3, E3 parcial (follows) | ordem estável; corte exato na janela; criador recebe 403 |
| 2.6 | Como pessoa ou criador, quero ver as publicações de um perfil por aba, para conhecer o que a conta publicou | `GET /users/:handle/posts?type=`; grade de fotos 3:4, lista de textos | FS | 5 | 2.3 | post de pessoa só visível a conexões (404 para o resto) |
| 2.7 | Como pessoa, quero curtir e descurtir, para reagir a uma publicação | tabela `likes`, `PUT/DELETE /posts/:id/like` idempotentes, contador na mesma transação; coração azul | FS | 3 | 2.5 | duas curtidas seguidas = 1; não existe lista de quem curtiu |
| 2.8 | Como pessoa ou criador, quero comentar, responder e apagar comentários, para conversar sobre a publicação 🔶 **PO: D11** (quem vê comentários) | tabela `comments`, rotas, 1 nível de resposta, exclusão pelo autor do comentário ou do post; `CommentsSheet` | FS | 5 | 2.5 | resposta de resposta = 400 |
| 2.9 | Como autor, quero apagar minha publicação, para retirá-la do ar | `DELETE /posts/:id` (soft delete + remoção de objetos) | FS | 2 | 2.3 | some do feed e do perfil na hora |
| 2.10 | Como pessoa, quero os posts de foto e texto exatamente como no protótipo, para me sentir em casa | `PostPhoto` (4:5, carrossel 1/3, pontos), `PostText` (thread), "Há 18 minutos", "Ver todos os N comentários" | F | 8 | 0.8 | revisão visual do UX contra p-06 e p-07 |
| 2.11 | Como dev, quero jobs de limpeza, para não acumular rascunhos e objetos órfãos | `@nestjs/schedule` com lock no Redis: rascunhos > 24 h, refresh tokens vencidos | B | 3 | 2.2 | rascunho de 25 h é apagado com seus objetos |

### Critérios de aceite (QA): E2

**2.1 Publicar texto (resumido)**
- **CA1** Dado um texto de 1 a 280 caracteres pela regra do TXT-01 (code points após NFC, a confirmar em A-09), quando publico, então o post nasce `published` e aparece no meu perfil; com 281 recebo 400. `[TXT-01]`
- **CA2** Dado emojis, acentos decompostos e `\r\n`, quando conto no app e na API, então os dois mostram o mesmo número (fixtures compartilhadas). `[TXT-02]`
- **CA3** Dado texto vazio, só espaços ou só caracteres invisíveis, quando tento publicar, então "Compartilhar" fica desabilitado e a API recusa com 400. `[TXT-01h, TXT-03]`
- **CA4** Dado o contador, quando passo de 260, 279 e 280, então a cor muda conforme o `ux.md` §4.5. `[TXT-03]`

**2.2 Publicar 1 a 4 fotos (completo, envolve privacidade da mídia)**
- **CA1** Dado 1 a 4 imagens JPEG/PNG/WebP de até 15 MB, quando crio o rascunho, envio e publico, então o post passa por `processing` e vira `published`. `[MID-01..03]`
- **CA2** Dado 0 ou 5 itens, tipo HEIC/GIF/PDF ou 15 MB + 1 byte, quando crio o rascunho, então recebo 400; o app impede a 5ª seleção com o Toast "Até 4 fotos por publicação." `[MID-01..03]`
- **CA3** Dado um arquivo maior que o `Content-Length` declarado, quando faço o PUT, então o S3 recusa. `[MID-03]`
- **CA4** Dado uma URL pré-assinada vencida, quando faço o PUT e depois o `publish`, então o PUT é recusado e o `publish` responde `MEDIA_NOT_UPLOADED`. `[MID-07]`
- **CA5** Dado o rascunho de outra pessoa, quando chamo `publish`, então recebo 404; dado `publish` repetido, então a chamada é idempotente. `[MID-08]`
- **CA6** Dado um post em `processing`, quando outra pessoa (mesmo conexão) consulta o feed, o perfil ou `GET /posts/:id`, então o post não aparece (404 no detalhe); eu vejo a faixa "Publicando…". `[MID-09]`
- **CA7** Dado uma imagem que falha no worker, quando ele desiste (3 tentativas → DLQ), então o post fica `failed` e o app mostra "Não foi possível publicar. Tentar de novo". `[MID-10]`
- **CA8** Dado um post de conta pessoal, quando a API gera URLs de leitura, então só quem passa no `AccessPolicyService` recebe URL assinada; URL adulterada ou sem assinatura → 403. `[PERM-16]`
- **CA9** Dado o upload em andamento, quando saio do app ou fico offline, então ao voltar vejo o estado real (concluído ou falha com "Tentar de novo"); offline no Compartilhar mostra "Sem internet. Sua publicação não foi enviada." `[MAN-UP-01]`

**2.3 Fotos sem localização (completo)**
- **CA1** Dado as fixtures JPEG, PNG e WebP com EXIF/GPS/XMP/IPTC, quando o worker processa, então `full` e `thumb` saem **sem nenhum** desses metadados. `[MID-05]`
- **CA2** Dado uma foto real tirada com localização no iPhone (HEIC) e no Android, quando publico pelo app e baixo a imagem servida, então não há GPS. `[MAN-UP-01]`
- **CA3** Dado uma foto com orientação EXIF de 90°, quando processada, então aparece na orientação certa. `[MID-05]`
- **CA4** Dado um HTML ou SVG declarado como JPEG, quando processado, então vira `failed` e nada é servido. `[MID-04]`
- **CA5** Dado um PNG de 30000×30000 px, quando processado, então vira `failed` sem derrubar o worker. `[MID-06]`
- **CA6** Dado o processamento concluído, quando verifico o S3, então o objeto em `incoming/` foi apagado.

**2.4 Foto de perfil (resumido)**
- **CA1** Dado uma imagem válida, quando troco a foto, então ela aparece no perfil e nos Avatares, sem metadados (mesmos casos do 2.3). `[MID-13]`
- **CA2** Dado "Remover foto", quando confirmo, então volto às iniciais sobre fundo pastel.

**2.5 Feed cronológico com "Você está em dia" (completo)** 🔶 D9
- **CA1** Dado conexões (dos dois lados do par) e criadores seguidos, quando abro o feed, então só vejo posts deles (e os meus, se D9 = sim); pessoais não conectados e criadores não seguidos nunca aparecem. `[FEED-01]`
- **CA2** Dado posts com horários diferentes e iguais, quando abro uma aba, então a ordem é `published_at` desc com desempate por id, estável entre chamadas. `[FEED-02]`
- **CA3** Dado `FEED_WINDOW_HOURS=72`, quando há posts a 71h59m59s, 72h00m00s e 72h00m01s, então os dois primeiros aparecem e o terceiro não; com `FEED_WINDOW_HOURS=1`, o corte vira 1 h; valor inválido impede a API de subir. `[FEED-03, FEED-03b]`
- **CA4** Dado 45 posts e páginas de 20, quando rolo até o fim, então recebo 20, 20 e 5, sem duplicar nem pular, e a última página traz `caughtUp=true`; também com 0, 20 e 21 posts. `[FEED-06]`
- **CA5** Dado um post novo publicado ou um post excluído entre duas páginas, quando carrego a próxima página, então não há duplicata nem lacuna. `[FEED-07]`
- **CA6** Dado um cursor adulterado, de outra aba ou com `since` além de janela + 1 h, quando chamo o feed, então recebo 400 ou o servidor limita a janela (nunca estende). `[FEED-08]`
- **CA7** Dado posts excluídos, em rascunho, processando ou com falha, quando abro o feed, então nenhum aparece. `[FEED-10]`
- **CA8** Dado um autor que excluiu a conta, quando abro o feed, então os posts dele já não aparecem. `[FEED-12]`
- **CA9** Dado um criador, quando chama `GET /feed`, então recebe 403. `[FEED-13]`
- **CA10** Dado o fim de qualquer aba, quando chego ao fim, então vejo "Você está em dia" com o texto conforme `windowHours`; sem conexões e sem criadores vejo o EmptyState "Seu início está vazio"; falha na página 2 mantém a página 1 e mostra "Tentar de novo". `[FEED-04, FEED-14]`
- **CA11** Dado o seed volumoso, quando meço o feed, então o p95 no servidor fica abaixo de 300 ms. `[FEED-16]`

**2.6 Publicações de um perfil por aba (completo)**
- **CA1** Dado um criador, quando qualquer conta autenticada abre o perfil dele, então vê as abas fotos (grade 3:4), textos (lista) e reels (grade 9:16). 
- **CA2** Dado uma conta pessoal, quando uma não conexão ou um criador chama `GET /users/:handle/posts` ou `GET /posts/:id`, então recebe 404 idêntico ao de inexistente; conexões e o dono recebem 200. `[PERM-13, PERM-14]`
- **CA3** Dado posts em `processing` ou `failed`, quando o dono abre o próprio perfil, então vê os tiles com o estado; outras pessoas não veem. `[MID-09]`
- **CA4** Dado `type` inválido ou cursor adulterado, quando chamo, então recebo 400.

**2.7 Curtir (completo)**
- **CA1** Dado um post visível, quando curto duas vezes seguidas, então existe uma curtida e `likeCount` sobe 1; quando descurto sem ter curtido, então nada muda e o contador não fica negativo. `[CNT-04]`
- **CA2** Dado 50 pessoas curtindo ao mesmo tempo, quando todas terminam, então `likeCount` = 50. `[CNT-04]`
- **CA3** Dado um post de pessoa não conectada, quando tento curtir, então recebo 404. `[PERM-14]`
- **CA4** Dado qualquer rota, quando procuro quem curtiu, então só existem `likeCount` e `likedByMe`; nenhuma lista. `[PERM-15]`
- **CA5** Dado falha de rede, quando curto, então o coração volta ao estado anterior e aparece o Toast "Não foi possível curtir."
- **CA6** Dado um criador (A-06), quando tenta curtir, então vale a regra decidida pelo PO (proposta: 403).

**2.8 Comentar, responder e apagar (completo)** 🔶 D11
- **CA1** Dado um post visível, quando comento com 1 a 500 caracteres, então o comentário aparece e `commentCount` sobe; vazio ou com 501 → 400. `[TXT-04]`
- **CA2** Dado um comentário, quando respondo, então a resposta fica recuada; resposta de uma resposta → 400.
- **CA3** Dado um post não visível para mim, quando listo ou crio comentários, então recebo 404. `[PERM-14]`
- **CA4** Dado um comentário, quando o autor do comentário ou o autor do post o apaga, então ele some e `commentCount` cai; qualquer outra pessoa recebe 404/403.
- **CA5** Dado a decisão D11, quando C (conexão de A) comenta e D (outra conexão de A, sem conexão com C) lê, então o comportamento é o decidido; se visível, o @ de C só é tocável quando o perfil de C é visível para D (`profileVisible`). `[PERM-10c]`
- **CA6** Dado um criador (A-06), quando responde a um comentário no próprio post, então é permitido; em post de outra conta, vale a regra decidida (proposta: 403).
- **CA7** Dado o autor de um comentário que excluiu a conta, quando listo os comentários, então vale a regra decidida (proposta: somem e o contador é ajustado). `[CONTA-03]`

**2.9 Apagar publicação (completo)**
- **CA1** Dado meu post, quando o apago, então ele some na hora do feed, do perfil, do detalhe (404) e dos contadores de publicações. `[FEED-10, CNT-05]`
- **CA2** Dado o post de outra pessoa, quando tento apagar, então recebo 404.
- **CA3** Dado o post apagado, quando o job roda, então os objetos de `media/` são removidos; URLs já emitidas param de funcionar no vencimento (até 6 h, A-19). `[MID-11]`
- **CA4** Dado um post apagado entre duas páginas do feed, quando carrego a próxima, então não há lacuna. `[FEED-07]`

**2.10 Posts iguais ao protótipo (resumido)**
- **CA1** Dado o catálogo e o feed com fixtures, quando comparo com p-06 e p-07, então o UX aprova (4:5, "1/3", pontos centralizados, "N curtidas" com singular/plural, "Ver todos os N comentários", tempo relativo).
- **CA2** Dado o aparelho físico, quando vejo "Há 18 minutos", "Ontem" e "27 out", então a formatação no Hermes é igual à dos testes. `[MAN-FEED-01]`

**2.11 Jobs de limpeza (resumido)**
- **CA1** Dado um rascunho com 25 h e um com 23 h, quando o job roda, então só o de 25 h é apagado, com seus objetos. `[MID-12]`
- **CA2** Dado duas instâncias do worker, quando o job dispara, então cada rascunho e cada objeto são apagados uma única vez (implementado com `FOR UPDATE SKIP LOCKED` no Postgres em vez de lock no Redis, Fase 2).

---

## E3: Busca de criadores, seguir e perfil de criador (Fase 3)

| # | História | Tarefas técnicas | Esp. | Pts | Depende de | CA essencial |
|---|---|---|---|---|---|---|
| 3.1 | Como pessoa, quero buscar criadores pelo @ (a partir de 3 letras), para encontrar quem quero seguir | `GET /search/creators?q=`, índice parcial por prefixo, máx. 20, ordem alfabética; tela Pesquisar sem sugestões | FS | 5 | E1 | contas pessoais nunca aparecem; q < 3 = 400 |
| 3.2 | Como pessoa que digitou o @ de outra pessoa, quero entender que contas pessoais só se conectam ao vivo, para saber o que fazer 🔶 **PO: novo** | mensagem no estado vazio da busca | F | 2 | 3.1 | **Atenção**: confirmar que o @ é de conta pessoal transforma a busca num oráculo de existência de contas. Recomendação: mostrar a dica sempre que não houver criador, sem confirmar nada |
| 3.3 | Como pessoa, quero seguir e deixar de seguir um criador, para ver as publicações dele no meu feed | tabela `follows` com FKs compostas, `PUT/DELETE /creators/:handle/follow`, rate limit 10/min; botão Seguir/Seguindo | FS | 3 | 3.1 | criador tentando seguir = 403 (guard) e recusado pelo banco |
| 3.4 | Como pessoa, quero ver o perfil de um criador, para decidir se vou segui-lo | perfil de criador visto por pessoa (p-17), contadores publicações/seguidores com cache 60 s | FS | 5 | 3.3, 2.6 | número de seguidores sem lista |
| 3.5 | Como criador, quero meu perfil com "Editar perfil" e "Nova publicação", para gerenciar minha conta | variação de perfil próprio do criador (p-19) | F | 2 | 1.5 | layout conforme protótipo |
| 3.6 | Como pessoa, quero ver só eu as minhas listas de conexões e de criadores seguidos, para manter meu grafo privado | `GET /me/connections`, `GET /me/following`; funções de repositório recebendo `AuthContext`; regra de lint de import | FS | 3 | 3.3 | não existe rota com id de terceiro que devolva lista |
| 3.7 | Como PO, quero testes automatizados das regras de permissão, para ter certeza de que valem no servidor | testes do `AccessPolicyService`, do guard, das FKs compostas e do trigger; **teste canário e2e** que percorre todas as rotas GET; snapshot dos schemas públicos | B | 8 | 3.6 | canário nunca aparece em nenhuma resposta |
| 3.8 | Como pessoa, quero que meus posts e meu perfil só apareçam para conexões, para ter privacidade | revisão de 1.5/2.6 com conexões reais (seed) e testes de 404 | B | 3 | 3.7 | não conexão recebe 404 em perfil e post |
| 3.9 | Como pessoa, quero que o feed inclua os criadores que sigo, para acompanhar quem me interessa | ligar `follows` ao CTE do feed, testes | B | 1 | 3.3, 2.5 | post de criador seguido aparece na hora |

### Critérios de aceite (QA): E3

**3.1 Buscar criadores pelo @ (completo)**
- **CA1** Dado criadores e pessoais com o mesmo prefixo, quando busco com 3 ou mais caracteres, então só criadores aparecem, no máximo 20, em ordem alfabética do @. `[BUS-04, BUS-07]`
- **CA2** Dado 0, 1 ou 2 caracteres (contados depois de remover o `@` inicial e espaços), quando busco, então a API responde 400 e o app nem chama a API e mostra "Digite pelo menos 3 letras." `[BUS-01, BUS-02, BUS-11]`
- **CA3** Dado maiúsculas e espaços (`" Estu "`), quando busco, então o resultado é o mesmo de `estu`. `[BUS-03]`
- **CA4** Dado o @ **exato** de uma conta pessoal, quando busco, então a resposta é `[]`, idêntica (status, corpo, headers) à de um @ inexistente. `[BUS-05]`
- **CA5** Dado `_` ou `%` na consulta, quando busco, então são tratados como texto (o `_` não funciona como curinga) e caracteres fora de `[a-z0-9._]` geram 400, nunca 500. `[BUS-06]`
- **CA6** Dado um criador excluído, quando busco o prefixo dele, então ele não aparece. `[BUS-08]`
- **CA7** Dado um criador logado, quando chama a busca, então recebe 403. `[BUS-08]`
- **CA8** Dado a tela Pesquisar vazia, quando abro, então não há sugestões, só a dica "Digite o @ de um criador." `[BUS-09]`
- **CA9** Dado o item do resultado, quando inspeciono, então traz só @, nome, avatar, número de seguidores e `followedByMe`. `[BUS-10]`

**3.2 Dica sobre contas pessoais na busca (completo)** 🔶 PO: novo (A-04)
- **CA1** Dado uma busca sem nenhum criador encontrado (seja um @ pessoal, seja um @ inexistente), quando a resposta chega, então o app mostra sempre a mesma mensagem: "Nenhum criador com esse @. Contas pessoais não aparecem na busca: elas só se conectam ao vivo." `[BUS-05, BUS-11]`
- **CA2** Dado qualquer consulta, quando comparo a resposta para um @ pessoal existente e para um inexistente, então não há diferença observável pela API. `[BUS-05]`

**3.3 Seguir e deixar de seguir (completo)**
- **CA1** Dado uma pessoa e um criador, quando a pessoa segue, então o botão vira "Seguindo", o contador "criadores" dela sobe na hora e o "seguidores" do criador sobe em até 60 s. `[CNT-02]`
- **CA2** Dado que já sigo o criador, quando sigo de novo, então continua existindo um follow só; quando deixo de seguir alguém que não sigo, então a resposta é 2xx sem efeito. `[PERM-04]`
- **CA3** Dado um criador logado, quando tenta seguir qualquer conta, então recebe 403 `ACCOUNT_TYPE_NOT_ALLOWED`; dado um INSERT direto no banco, então a FK composta recusa. `[PERM-01, PERM-02]`
- **CA4** Dado o @ de uma conta pessoal, quando uma pessoa tenta segui-lo, então recebe 404 idêntico ao de @ inexistente. `[PERM-03]`
- **CA5** Dado 10 follows/unfollows no último minuto, quando faço o 11º, então recebo 429.
- **CA6** Dado falha de rede, quando toco Seguir, então o botão volta ao estado anterior e aparece um Toast.

**3.4 Perfil de criador visto por pessoa (completo)**
- **CA1** Dado um criador, quando uma pessoa abre o perfil, então vê publicações e seguidores (números), o nome, "Criador de conteúdo · não segue ninguém", a bio e Seguir/Seguindo, como em p-17.
- **CA2** Dado o número de seguidores, quando tento tocar nele ou procurar uma rota de lista, então não há lista para ninguém, nem para o próprio criador. `[PERM-09, PERM-10]`
- **CA3** Dado follows de contas excluídas, quando vejo o número de seguidores, então elas não contam. `[CNT-02, CNT-03]`

**3.5 Perfil próprio do criador (resumido)**
- **CA1** Dado um criador no próprio perfil, quando abro, então vejo "Editar perfil" e "Nova publicação" conforme p-19, e o número de seguidores não é tocável.

**3.6 Listas próprias de conexões e criadores seguidos (completo)**
- **CA1** Dado uma pessoa logada, quando chama `GET /me/connections` e `GET /me/following`, então recebe só as próprias listas, com a nota "Só você vê esta lista." no app.
- **CA2** Dado parâmetros extras (`?userId=`, `?handle=`), quando chamo as listas, então são recusados (400) ou ignorados; nunca devolvem a lista de outra pessoa. `[PERM-08]`
- **CA3** Dado o inventário de rotas, quando o teste estático roda, então nenhuma rota com `:id`/`:handle` devolve lista de relacionamentos. `[PERM-09]`
- **CA4** Dado um criador, quando chama essas rotas, então recebe 403. `[PERM-05]`
- **CA5** Dado um import da função de listagem fora do `MeController`, quando rodo `pnpm lint`, então o lint falha.
- **CA6** Dado conexões ou criadores excluídos, quando vejo minhas listas, então eles não aparecem.

**3.7 Testes automatizados de permissão (completo)**
- **CA1** Dado o seed canário, quando o teste enumera todas as rotas GET e chama cada uma como conexão de Y, pessoa desconhecida, criador e anônimo, então nenhuma resposta contém `canary_conn_*` nem `canary_creator_*` (fora da allowlist). `[PERM-10]`
- **CA2** Dado uma rota GET nova sem fixture de parâmetro, quando o canário roda, então o teste falha. `[PERM-10]`
- **CA3** Dado as rotas POST que devolvem dados (`resolve`, `requests`, `login`, `refresh`), quando o canário roda, então também não vazam. `[PERM-10b]`
- **CA4** Dado todas as rotas dos módulos de conexão, proximidade, feed, busca e seguir, quando o teste de guard roda, então cada uma responde 403 a um criador e o teste falha se faltar o guard. `[PERM-05]`
- **CA5** Dado o banco, quando o teste de integração tenta gravar follow de criador, conexão com criador, par invertido, pedido para si mesmo ou troca de tipo de conta, então todos são recusados. `[PERM-02, PERM-06]`
- **CA6** Dado o snapshot dos schemas públicos, quando um campo é adicionado, então o teste falha até o snapshot ser revisado no PR. `[PERM-11]`
- **CA7** Dado cada teste de permissão, quando a regra é removida localmente, então o teste falha (demonstrado no PR).

**3.8 Posts e perfil pessoal só para conexões (completo)**
- **CA1** Dado A e B conectados (seed) e C sem conexão, quando C ou um criador consulta o perfil, a aba de posts, um post, os comentários ou tenta curtir/comentar um post de A, então recebe 404 idêntico ao de inexistente; B recebe 200. `[PERM-13, PERM-14]`
- **CA2** Dado URLs de mídia de A, quando C tenta obtê-las, então nenhuma URL assinada é emitida para C. `[PERM-16]`

**3.9 Feed com criadores seguidos (completo)**
- **CA1** Dado que passo a seguir um criador, quando abro o feed, então os posts dele das últimas 72 h aparecem na hora. `[FEED-01]`
- **CA2** Dado que deixo de seguir, quando carrego o feed (inclusive a próxima página com cursor antigo), então os posts dele somem. `[FEED-11]`

---

## E4: Conexão presencial (Fase 4)

| # | História | Tarefas técnicas | Esp. | Pts | Depende de | CA essencial |
|---|---|---|---|---|---|---|
| 4.1 | Como dev, quero validar o BLE em aparelhos reais antes de construir a tela, para reduzir o maior risco técnico 🔶 **PO: D1** | spike com 2 iPhones + Samsung + outro Android: anunciar UUID de 128 bits e varrer | F | 8 | E0, aparelhos | relatório com matriz de aparelhos e tempo de descoberta |
| 4.2 | Como pessoa, quero que o app gere um código temporário quando abro Conectar, para ser encontrada só enquanto estou ali | `POST /proximity/tokens` (12 bytes, hash no Redis, TTL 30/120 s, `prox:u`), rotação a cada 20 s, rate limits, fail-closed | B | 5 | E1 | token expirado não resolve; Redis fora = mensagem amigável |
| 4.3 | Como pessoa, quero que o celular encontre quem está perto sem parear, para conectar rápido 🔶 **PO: D1** | módulo Expo `sussurro-proximity` (Swift + Kotlin): advertise/scan, `getCapabilities`, config plugin de permissões | F | 13 | 4.1 | anúncio sem nome do aparelho; para ao sair da tela |
| 4.4 | Como pessoa, quero ver a lista "Por perto agora", para escolher com quem conectar 🔶 **PO: D3, D13** | `POST /proximity/resolve`; tela Conectar (seletor, botão Procurar, radar com redução de movimento, lista por força de sinal em faixas); estados de Bluetooth desligado/negado | F | 8 | 4.2, 4.3 | só aparecem pessoas com a tela aberta |
| 4.5 | Como pessoa, quero enviar um pedido de conexão e ver "Aguardando confirmar", para saber o que está acontecendo | tabelas `connection_requests` e `connections`; `POST /connections/requests` com advisory lock e corrida A→B ∥ B→A; polling do status; estados "não confirmado" | FS | 5 | 4.4 | pedidos simultâneos viram conexão única |
| 4.6 | Como pessoa, quero receber o pedido numa folha com Aceitar/Recusar, para confirmar só quem está comigo | `GET .../incoming` (polling 2 s com a tela aberta), `accept` com `observedToken`, `decline` com cooldown 1 h; tela "Conectados" | FS | 5 | 4.5 | aceite sem ter visto o token do outro = recusado |
| 4.7 | Como pessoa sem BLE funcionando, quero conectar por QR code, para não ficar sem opção 🔶 **PO: D3, D7** | exibir e ler QR (`expo-camera`), `method: 'qr'`, segunda leitura no aceite se D7 = cruzado | F | 5 | 4.6 | método `qr` registrado na conexão |
| 4.8 | Como criador, quero ver que Conectar não está disponível para mim, para entender a regra | tela bloqueada (p-22) + 403 nas rotas | FS | 1 | 4.2 | criador recebe 403 em todas as rotas de proximidade |
| 4.9 | Como pessoa, quero desfazer uma conexão, para controlar quem vê meus posts 🔶 **PO: D8** | `DELETE /connections/:handle`, efeito imediato no feed e nas visibilidades | FS | 3 | 4.6, decisão | **pendente** |
| 4.10 | Como PO, quero testes do protocolo, para garantir que só conecta quem está junto | lista obrigatória do ADR 0003: token expirado, de outro dono, criador, simultâneos, aceite duplo, após expiração, cooldown, rate limit, replay | B | 8 | 4.6 | todos os casos do ADR cobertos |
| 4.11 | Como dev testando sozinho, quero simular um pedido recebido, para testar a folha sem um segundo aparelho 🔶 **PO: D15** | rota `/dev/simulate-request` ausente do build de produção | B | 2 | 4.6 | rota não existe com `NODE_ENV=production` |

### Critérios de aceite (QA): E4

**4.1 Spike de BLE (completo)** 🔶 D1
- **CA1** Dado os aparelhos da matriz (`testes.md` §8.1), quando cada par (iOS↔iOS, iOS↔Android, Android↔Android) roda o protótipo do módulo com as duas telas abertas, então o relatório registra se cada lado descobre o outro e o tempo até a descoberta (meta < 10 s). `[MAN-BLE-01]`
- **CA2** Dado o anúncio, quando inspeciono com nRF Connect, então só há o UUID de 128 bits com o prefixo do Sussurro, sem nome do aparelho, e ele muda quando o token muda. `[PROX-28]`
- **CA3** Dado o app em background ou a tela fechada, quando inspeciono, então o anúncio e a varredura pararam. `[PROX-28]`
- **CA4** Dado um aparelho sem suporte a anúncio, quando chamo `getCapabilities()`, então ele informa isso. 
- **CA5** Dado qualquer par que não descubra, quando o spike termina, então a decisão (fallback GATT, `munim-bluetooth` ou só QR naquele par) vai ao PO antes da 4.3.

**4.2 Token temporário de proximidade (completo)**
- **CA1** Dado uma pessoa com a tela Conectar aberta, quando o app pede um token, então recebe 16 caracteres base64url com validade de 30 s, e o Redis guarda só o hash. `[PROX-01]`
- **CA2** Dado um token com 29 s, quando outra pessoa o resolve, então ele resolve; com 31 s, a resposta é igual à de um token inexistente. `[PROX-02]`
- **CA3** Dado a tela aberta, quando passam 20 s, então o app renova o token (e o anúncio/QR) sem piscar.
- **CA4** Dado 6 tokens no último minuto, quando peço o 7º, então recebo 429. `[PROX-20]`
- **CA5** Dado o Redis fora, quando peço token, então recebo 503 `PROXIMITY_UNAVAILABLE` e o app mostra "Conectar está indisponível agora"; login e feed continuam funcionando. `[PROX-21]`
- **CA6** Dado logout ou exclusão de conta, quando alguém tenta resolver meu token, então ele não resolve. `[PROX-27]`
- **CA7** Dado um criador, quando pede token, então recebe 403. `[PROX-08]`

**4.3 Módulo BLE (completo)** 🔶 D1
- **CA1** Dado dois aparelhos da matriz com a tela Conectar aberta, quando procuram, então cada um vê o outro em menos de 10 s na maioria das tentativas (registrar a taxa por par). `[MAN-BLE-01]`
- **CA2** Dado o anúncio, quando inspeciono, então não há nome do aparelho nem dado estável. `[PROX-28]`
- **CA3** Dado que saio da tela ou mando o app para background, quando inspeciono, então anúncio e varredura param, e ao voltar recomeçam.
- **CA4** Dado Bluetooth desligado, permissão negada ou aparelho que não anuncia, quando abro Conectar, então vejo o estado correspondente do `ux.md` §4.12 com a opção de QR. `[MAN-BLE-03]`
- **CA5** Dado Android 12+, quando peço permissão, então só são pedidas `BLUETOOTH_SCAN` (`neverForLocation`), `BLUETOOTH_ADVERTISE` e `BLUETOOTH_CONNECT`; localização só é pedida em Android ≤ 11.
- **CA6** Dado a lógica de montar e ler o UUID (prefixo + 12 bytes), quando rodo os testes em TypeScript, então ida e volta dão o mesmo token e UUIDs sem o prefixo são ignorados.

**4.4 Lista "Por perto agora" (completo)** 🔶 D3, D13
- **CA1** Dado duas pessoas com a tela aberta e tokens trocados por BLE, quando o app chama `POST /proximity/resolve`, então recebe @, nome, avatar e `alreadyConnected` de cada token válido. `[PROX-05]`
- **CA2** Dado que o chamador não está com a tela aberta (`prox:u` ausente), quando chama `resolve`, então é recusado. `[PROX-04]`
- **CA3** Dado tokens inválidos, vencidos ou do próprio chamador, quando chama `resolve`, então eles não aparecem na resposta. `[PROX-05]`
- **CA4** Dado uma pessoa já conectada, quando ela aparece na lista, então tem o rótulo "Conectados" no lugar do botão.
- **CA5** Dado o token de B rotacionado entre a lista e o toque em "Conectar", quando toco, então o app usa o token mais recente de B; se B saiu, a linha some com o Toast "Caio saiu de perto. Procure de novo." `[PROX-25]`
- **CA6** Dado 20 s sem ninguém, quando continuo na tela, então vejo "Ninguém por perto ainda" com o botão de QR, e a varredura continua.
- **CA7** Dado 3 ou mais pessoas por perto durante 5 min de uso normal, quando uso a tela, então o rate limit de `resolve` não dispara. `[MAN-BLE-04, A-17]`
- **CA8** Dado a decisão D13, quando vejo a lista, então ela está ordenada pelo sinal e mostra a faixa ("bem perto"/"por perto") ou a distância decidida.
- **CA9** Dado Reduzir movimento ligado, quando procuro, então o radar fica estático.

**4.5 Enviar pedido e "Aguardando" (completo)**
- **CA1** Dado o token válido de B e a minha tela aberta, quando toco Conectar, então o pedido é criado (`pending`, validade de 120 s, `method` gravado) e vejo "Aguardando Caio confirmar". `[PROX-06, PROX-22]`
- **CA2** Dado que A→B e B→A são enviados ao mesmo tempo, quando os dois chegam, então existe exatamente 1 conexão e os dois veem "Conectados" (repetido 50 vezes no teste). `[PROX-13]`
- **CA3** Dado o meu próprio token (inclusive de outro aparelho com a mesma conta), quando tento enviar, então recebo erro e nada é gravado. `[PROX-07]`
- **CA4** Dado que já estamos conectados, quando envio, então recebo 409 e o Toast "Vocês já estão conectados." `[PROX-19]`
- **CA5** Dado um pedido A→B já pendente, quando A envia de novo, então recebe o mesmo pedido (ou 409, conforme decidido); depois da expiração, pode enviar outro. `[PROX-16]`
- **CA6** Dado que B já tem um pendente de C, quando A envia para B, então é permitido. `[PROX-23]`
- **CA7** Dado 10 pedidos no último minuto ou 50 no dia, quando envio mais um, então recebo 429 e vejo o estado "Muitas tentativas". `[PROX-20]`
- **CA8** Dado o pedido sem resposta por 120 s, quando ele expira, então A vê "Caio não confirmou" com "Tentar de novo". `[PROX-15]`
- **CA9** Dado "Cancelar pedido", quando A cancela, então B não consegue mais aceitar e só A pode cancelar. `[PROX-18]`
- **CA10** Dado um terceiro C, quando chama `GET /connections/requests/:id` de um pedido A→B, então recebe 404. `[PROX-12]`

**4.6 Receber o pedido e confirmar (completo)**
- **CA1** Dado B com a tela Conectar aberta, quando chega um pedido, então em até ~2 s abre a folha "Helena quer se conectar" com avatar, nome, @, "Aceitar", "Recusar" e o tempo restante.
- **CA2** Dado B aceitando com o `tA` que observou (válido ou com até 120 s), quando confirma, então a conexão é criada com o `method` do pedido e os dois veem "Conectados". `[PROX-09]`
- **CA3** Dado B aceitando sem `observedToken`, com o token de outra pessoa ou com `tA` acima de 120 s, quando confirma, então é recusado e o pedido continua pendente. `[PROX-09, PROX-03]`
- **CA4** Dado B sem a tela aberta, quando tenta aceitar, então é recusado. `[PROX-10]`
- **CA5** Dado aceite repetido ou dois toques simultâneos, quando processado, então há 1 conexão e respostas iguais. `[PROX-11c, PROX-14]`
- **CA6** Dado o pedido vencido, quando B aceita, então recebe 410 e a folha fecha com o Toast "O pedido da Helena expirou." `[PROX-15]`
- **CA7** Dado a folha aberta perto do fim do prazo, quando B aceita aos 110 s, então o app envia o `tA` mais recente e o aceite funciona. `[PROX-26, A-10]`
- **CA8** Dado B recusando, quando A tenta de novo em menos de 1 h, então A recebe a mesma mensagem genérica de token inválido e nunca sabe que foi recusado. `[PROX-17]`
- **CA9** Dado um terceiro C, quando tenta aceitar ou recusar um pedido A→B, então recebe 404. `[PROX-12]`
- **CA10** Dado vários pedidos, quando chegam, então as folhas aparecem uma por vez.
- **CA11** Dado 10 aceites no último minuto, quando faço o 11º, então recebo 429. `[PROX-20]`

**4.7 Conectar por QR (completo)** 🔶 D3, D7
- **CA1** Dado a aba "QR code", quando abro, então vejo meu QR (`sussurro://c/{token}`) que se renova a cada 20 s sem piscar, com meu avatar e @.
- **CA2** Dado A lendo o QR de B, quando o token é válido, então o pedido é criado com `method: "qr"`. `[PROX-22]`
- **CA3** Dado D7 = QR cruzado, quando B recebe o pedido, então só consegue aceitar lendo o QR de A, exibido na tela "Aguardando"; o aceite sem leitura é recusado pelo servidor. `[PROX-24]`
- **CA4** Dado um QR vencido ou adulterado, quando leio, então vejo uma mensagem amigável e nada é criado. `[PROX-24]`
- **CA5** Dado a câmera negada, quando tento ler, então vejo "Câmera sem permissão" com "Abrir Ajustes" e "Mostrar meu código". `[MAN-QR-01]`
- **CA6** Dado a câmera do sistema lendo o QR, quando o app abre pelo deep link, então inicia o fluxo QR; sem sessão, guarda o token e o descarta se passaram mais de 30 s. `[PROX-24]`
- **CA7** Dado 20 falhas de token em 10 min, quando leio mais um QR, então a proximidade fica bloqueada por 15 min, também no QR. `[PROX-20]`

**4.8 Conectar bloqueado para criador (completo)**
- **CA1** Dado um criador, quando chama cada rota de proximidade e de conexão, então recebe 403 `ACCOUNT_TYPE_NOT_ALLOWED` em todas. `[PERM-05, PROX-08]`
- **CA2** Dado um criador, quando tenta abrir Conectar (inclusive por deep link `sussurro://c/...`), então vê a tela de p-22 com "Voltar ao perfil".

**4.9 Desfazer conexão (completo, pendente D8)**
- **CA1** Dado A e B conectados, quando A desfaz a conexão, então a linha some, os contadores dos dois caem e B não é notificado. `[CNT-03]`
- **CA2** Dado a conexão desfeita, quando A ou B carregam feed, perfil ou post do outro (inclusive com cursor antigo), então recebem 404 / os posts somem. `[FEED-11, PERM-13]`
- **CA3** Dado um @ que não é minha conexão, quando chamo `DELETE /connections/:handle`, então recebo 404 idêntico ao de inexistente.
- **CA4** Dado URLs de mídia já emitidas, quando a conexão é desfeita, então elas valem até vencer (até 6 h, A-19), como documentado.

**4.10 Testes do protocolo (completo)**
- **CA1** Dado a suíte de proximidade, quando roda no CI contra Postgres e Redis reais, então cobre PROX-01 a PROX-23, PROX-25 a PROX-27 e PROX-30, sem `sleep` (relógio e TTL controlados).
- **CA2** Dado o teste de corrida A→B ∥ B→A, quando executado 50 vezes, então nunca gera duas conexões nem deixa pendente. `[PROX-13]`
- **CA3** Dado cada regra do protocolo, quando removida localmente, então pelo menos um teste falha (demonstrado no PR).

**4.11 Simular pedido recebido (completo)** 🔶 D15
- **CA1** Dado `NODE_ENV=development`, quando chamo `/dev/simulate-request`, então um pedido de uma persona de seed aparece na minha folha.
- **CA2** Dado `NODE_ENV=production`, quando chamo a rota, então recebo 404 (a rota nem é registrada). `[PROX-30]`
- **CA3** Dado um build `preview`/`production`, quando abro Conectar, então o botão "Simular um pedido recebido" não existe.

---

## E5: Reels (Fase 5)

| # | História | Tarefas técnicas | Esp. | Pts | Depende de | CA essencial |
|---|---|---|---|---|---|---|
| 5.1 | Como dev, quero a interface `VideoProcessor` com implementação de passthrough, para desenvolver sem a AWS | interface, `PassthroughVideoProcessor`, seleção por env | B | 3 | E2 | troca por `VIDEO_PROCESSOR` sem mudar código |
| 5.2 | Como pessoa, quero que meus reels sejam convertidos para tocar bem em qualquer celular | `MediaConvertVideoProcessor` (MP4 720×1280 + poster), consumidor `video-events`, remoção do GPS do container | B | 8 | 5.1 | vídeo de iPhone com GPS sai sem localização |
| 5.3 | Como pessoa ou criador, quero publicar um reel vertical curto, para compartilhar um vídeo 🔶 **PO: D10** | rascunho tipo reel com limites (90 s, 200 MB), thumbnail no app (`expo-video-thumbnails`), modo REEL no Criar, estado "processando" | FS | 5 | 5.1 | vídeo de 91 s = 400 |
| 5.4 | Como pessoa, quero ver reels em grade 3 colunas com a duração, para escolher o que assistir | `ReelTile` (9:16) no feed e no perfil | F | 3 | 5.3 | grade conforme p-08 |
| 5.5 | Como pessoa, quero assistir a um reel em tela cheia sem que o próximo comece sozinho, para assistir no meu ritmo | `ReelViewer` com `expo-video`, curtir/comentar | F | 8 | 5.4 | ao terminar, não avança automaticamente |
| 5.6 | Como pessoa, quero ver um aviso se o reel falhar, para tentar de novo | estado `failed`, ação de nova tentativa | FS | 3 | 5.2 | falha não deixa post fantasma no feed |

### Critérios de aceite (QA): E5

**5.1 `VideoProcessor` e passthrough (resumido)**
- **CA1** Dado `VIDEO_PROCESSOR=passthrough`, quando publico um reel em dev, então ele vira `ready` com o poster enviado pelo app; trocar para `mediaconvert` não exige mudar código.
- **CA2** Dado um valor inválido em `VIDEO_PROCESSOR`, quando o worker sobe, então falha no boot.

**5.2 Conversão com MediaConvert (completo, privacidade)**
- **CA1** Dado um vídeo de iPhone gravado com localização, quando o MediaConvert processa, então o MP4 servido não tem metadados de localização e o original em `incoming/` é apagado. **Só verificável na AWS (A-21)**: fica como teste de fumaça pós-apply, com o roteiro pronto. `[MID-14]`
- **CA2** Dado o evento `COMPLETE` ou `ERROR` na fila `video-events`, quando o worker consome, então o post vira `published` ou `failed`; evento repetido é idempotente.
- **CA3** Dado um evento com `userMetadata.app` diferente ou de job desconhecido, quando chega, então é descartado sem efeito.
- **CA4** Dado o passthrough em dev, quando uso vídeos de teste, então são vídeos sem localização (regra do roteiro, porque o passthrough copia os metadados).

**5.3 Publicar reel (resumido)** 🔶 D10
- **CA1** Dado um vídeo vertical de até 90 s e 200 MB, quando publico, então vejo "Processando o reel…" e depois o reel na grade. `[MID-14]`
- **CA2** Dado 91 s ou 200 MB + 1 byte, quando crio o rascunho, então recebo 400; a grade do Criar mostra os vídeos longos esmaecidos com "Até 90 s".
- **CA3** Dado um reel em processamento, quando outra pessoa abre o feed ou o perfil, então ele não aparece. `[MID-09]`

**5.4 Grade de reels (resumido)**
- **CA1** Dado reels publicados, quando abro a aba Reels do feed ou do perfil, então vejo a grade 3 colunas 9:16 com a duração legível sobre a miniatura (scrim), conforme p-08.

**5.5 Visualizador sem avançar sozinho (resumido)**
- **CA1** Dado um reel aberto, quando ele termina, então para no último quadro com "Assistir de novo" e nunca abre outro sozinho.
- **CA2** Dado VoiceOver/TalkBack ligado, quando assisto, então há botão explícito de pausar e os controles não somem.

**5.6 Aviso de falha (resumido)**
- **CA1** Dado um reel que falhou, quando abro meu perfil, então o tile mostra "Falhou" com "Tentar de novo"/"Excluir"; ninguém mais vê o post. `[MID-10]`

---

## E6: Notificações, push e Sentry (Fase 6)

| # | História | Tarefas técnicas | Esp. | Pts | Depende de | CA essencial |
|---|---|---|---|---|---|---|
| 6.1 | Como pessoa, quero ver notificações de curtidas, comentários, respostas e conexões, para acompanhar as interações | tabela `notifications`, criação na mesma transação, `GET /notifications`, tela com "Hoje"/"Esta semana" | FS | 5 | E2, E4 | curtir/descurtir repetido gera 1 notificação |
| 6.2 | Como pessoa, quero um ponto azul no coração quando houver novidades, para saber que há algo novo | `unread-count`, `POST /notifications/read {upTo}` | FS | 2 | 6.1 | ponto some ao abrir |
| 6.3 | Como criador, quero saber quantas pessoas novas me seguiram, sem saber quem, para acompanhar meu alcance | upsert por dia com `actor_id` nulo, tela de notificações do criador (p-21) | FS | 3 | 6.1, 3.3 | nenhuma resposta contém id de quem seguiu |
| 6.4 | Como pessoa, quero autorizar notificações no celular, para ser avisada fora do app | `expo-notifications`, permissão, `PUT/DELETE /me/push-tokens`, logout desativa o token | FS | 3 | E1 | token desativado após logout |
| 6.5 | Como pessoa, quero receber push das interações, para não perder nada | fila `push`, envio em lotes, recibos, `DeviceNotRegistered` | B | 5 | 6.4 | texto do push não traz a íntegra do comentário |
| 6.6 | Como pessoa, quero receber push de pedido de conexão, para não depender de ficar olhando a tela | push do pedido (complementa o polling da Fase 4) | FS | 2 | 6.5, E4 | |
| 6.7 | Como dev, quero o Sentry completo, para investigar erros de produção sem expor dados 🔶 **PO: D4** | source maps no EAS, releases, ambientes, `beforeSend` que remove relacionamentos e tokens, tracing com amostragem, alertas | FS | 5 | 0.9 | evento de teste sem campos sensíveis |
| 6.8 | Como dev, quero pontos de OpenTelemetry preparados, para instrumentar depois sem refatorar | interfaces/hooks de tracing desligados por padrão | B | 2 | 6.7 | sem custo quando desligado |

### Critérios de aceite (QA): E6

**6.1 Notificações de interações (resumido)**
- **CA1** Dado curtida, comentário, resposta ou conexão criada, quando o evento acontece, então a notificação é gravada na mesma transação e aparece em "Hoje" ou "Esta semana". `[PROX-29]`
- **CA2** Dado curtir e descurtir várias vezes, quando vejo as notificações, então há uma só; curtir o próprio post não gera notificação. `[NOT-07]`
- **CA3** Dado um post ou autor excluído, quando abro as notificações, então a notificação dele sumiu. `[NOT-09]`

**6.2 Ponto azul (resumido)**
- **CA1** Dado notificações não lidas, quando abro o feed, então o coração tem o ponto azul; ao abrir Notificações e marcar como lidas, o ponto some. `[NOT-06]`

**6.3 Seguidores agregados e anônimos (completo)**
- **CA1** Dado 3 pessoas seguindo o criador no mesmo dia (America/Sao_Paulo), quando ele abre Notificações, então vê uma linha "3 novas pessoas começaram a seguir você." com o avatar "+3". `[NOT-01, NOT-05]`
- **CA2** Dado essas notificações, quando inspeciono as respostas de `/notifications`, `/unread-count`, o perfil e o push do criador, então nenhuma contém id, @ ou nome de quem seguiu (canário de seguidores); o banco tem `actor_id` nulo garantido por `CHECK`. `[NOT-02]`
- **CA3** Dado follows às 23:59 e às 00:01 (horário de Brasília), quando vejo as notificações, então são duas linhas, uma por dia. `[NOT-03]`
- **CA4** Dado unfollow e novo follow no mesmo dia, quando vejo a notificação, então o número não diminui e soma de novo (aceito no ADR 0011). `[NOT-04]`
- **CA5** Dado uma notificação de seguidores já lida, quando chega um novo seguidor no mesmo dia, então ela volta a ficar não lida. `[NOT-06]`
- **CA6** Dado 1 seguidor, quando vejo a linha, então o texto está no singular ("1 nova pessoa começou a seguir você."). `[NOT-05]`

**6.4 Autorizar notificações no celular (completo, privacidade do aparelho)**
- **CA1** Dado a primeira conexão ou o primeiro post, quando o app pergunta "Quer saber quando alguém curtir ou comentar?" e eu ativo, então o token Expo é registrado para o meu usuário e plataforma.
- **CA2** Dado logout neste aparelho, quando alguém interage comigo, então este aparelho não recebe mais push. `[AUTH-12]`
- **CA3** Dado outra pessoa tentando registrar ou apagar um token que não é dela, quando chama `PUT/DELETE /me/push-tokens`, então só afeta os próprios tokens (o token de terceiro não é desativado).
- **CA4** Dado a permissão negada no sistema, quando uso o app, então nada quebra e não há novo pedido insistente.

**6.5 Push das interações (completo, privacidade do conteúdo)**
- **CA1** Dado um comentário, quando o push chega, então o texto é curto ("lucasf comentou na sua foto") e não traz a íntegra do comentário. `[NOT-08]`
- **CA2** Dado novos seguidores de um criador, quando há push, então ele é agregado e anônimo. `[NOT-08]`
- **CA3** Dado um recibo `DeviceNotRegistered`, quando o worker o processa, então o token é desativado. `[NOT-08]`
- **CA4** Dado o Expo Push fora do ar, quando ocorre uma interação, então a notificação continua no app; o push vai para a DLQ após 3 tentativas.
- **CA5** Dado o app fechado no iPhone e no Android, quando recebo e toco no push, então abre a tela certa. `[MAN-PUSH-01]`

**6.6 Push de pedido de conexão (resumido)**
- **CA1** Dado um pedido para mim com o app fechado, quando toco no push, então o app abre o Conectar; o aceite continua exigindo a tela aberta e o token cruzado.

**6.7 Sentry completo (completo, privacidade)** 🔶 D4
- **CA1** Dado um erro numa requisição com `Authorization`, `password`, `token`, `observedToken` ou `targetToken`, quando o evento chega ao Sentry, então nenhum desses valores aparece. `[PERM-17]`
- **CA2** Dado um erro numa rota que manipula relacionamentos, quando o evento é enviado, então o `beforeSend` remove listas e ids de relacionamento.
- **CA3** Dado um build EAS com `SENTRY_AUTH_TOKEN`, quando ocorre um erro no app, então o stack aparece com source maps e com a release e o ambiente corretos.
- **CA4** Dado `sendDefaultPii`, quando inspeciono a config dos três projetos, então é `false`.

**6.8 Pontos de OpenTelemetry (resumido)**
- **CA1** Dado `OTEL_ENABLED=false`, quando a API roda, então não há exportador nem custo mensurável; o `traceId` aparece no log.

---

## E7: Terraform (só código) e documentação de deploy (Fase 7)

**Nunca rodar `terraform apply`.** Responsável principal: DevOps.

| # | História | Tarefas técnicas | Esp. | Pts | Depende de | CA essencial |
|---|---|---|---|---|---|---|
| 7.1 | Como operador, quero a rede e o ECS/Fargate descritos em Terraform, para subir a API e o worker | VPC, subnets, ALB + TLS, cluster, serviços, autoscaling mínimo | D | 8 | E6 | `terraform validate` e `plan` sem erro (sem apply) |
| 7.2 | Como operador, quero RDS e ElastiCache em Terraform, para ter os dados gerenciados | RDS Postgres 18 Multi-AZ, PITR 14 dias, ElastiCache Valkey | D | 5 | 7.1 | |
| 7.3 | Como operador, quero S3 + CloudFront com URLs assinadas, para servir mídia com privacidade | buckets privados, OAC, key group, lifecycle de `incoming/` | D | 5 | 7.1 | |
| 7.4 | Como operador, quero as filas e o MediaConvert em Terraform, para o pipeline de mídia funcionar na AWS | SQS + DLQs, role do MediaConvert, regra do EventBridge | D | 3 | 7.1 | |
| 7.5 | Como operador, quero segredos e permissões mínimas, para reduzir o risco de vazamento | Secrets Manager/SSM, IAM por serviço | D | 3 | 7.1 | |
| 7.6 | Como operador, quero imagens Docker de produção da API e do worker, para rodar no Fargate | Dockerfiles multi-stage `node:26-slim`, usuário não root | D+B | 3 | E0 | imagem sobe e responde `/health/ready` |
| 7.7 | Como operador, quero a documentação de deploy e rollback, para publicar com segurança | runbook: migrations, deploy, rollback, rotação de segredos | D | 3 | 7.1–7.6 | outra pessoa consegue seguir sem ajuda |
| 7.8 | Como PO, quero os perfis de produção do EAS e o roteiro de envio às lojas, para publicar o app | `eas.json` produção, `eas submit`, checklist da App Store (exclusão de conta, privacidade) | D+F | 3 | E6 | checklist completo |
| 7.9 | Como PO, quero alarmes de custo, para não ter surpresa na fatura | budget alarm (MediaConvert, CloudFront) | D | 3 | 7.4 | |

### Critérios de aceite (QA): E7

Para todo o épico: **CA0** Dado qualquer PR da Fase 7, quando o CI roda, então `terraform fmt -check`, `validate`, `tflint` e `trivy config` passam, e nenhum job tem credencial AWS nem roda `plan` ou `apply`.

**7.1, 7.2, 7.4, 7.6, 7.7, 7.8, 7.9 (resumido)**
- **7.1** Dado o módulo de rede e ECS, quando reviso, então a API só aceita entrada do SG do ALB, o worker não tem ingress e RDS/Valkey ficam em subnets sem rota para a internet.
- **7.2** Dado RDS e Valkey, quando reviso, então há Multi-AZ conforme decisão P5, backups de 14 dias, PITR, `deletion_protection`, `force_ssl` e TLS no Valkey.
- **7.4** Dado as filas, quando reviso, então cada uma tem DLQ com `maxReceiveCount = 3` e a fila `video-events` só aceita a regra do EventBridge.
- **7.6** Dado a imagem Docker, quando rodo localmente, então ela sobe como usuário não root e responde `/health/ready`.
- **7.7** Dado o runbook, quando outra pessoa (o QA) o segue num ensaio de leitura, então não há passo ambíguo e o rollback está descrito.
- **7.8** Dado o checklist da App Store, quando reviso, então exclusão de conta, política de privacidade e (se D5) denúncia/bloqueio estão cobertos.
- **7.9** Dado os budgets, quando reviso, então há alertas a 50%, 80% e 100% e um orçamento só para MediaConvert e CloudFront.

**7.3 S3 + CloudFront com URLs assinadas (completo, privacidade)**
- **CA1** Dado o bucket de mídia, quando reviso o Terraform, então Block Public Access está ligado, a origem do CloudFront usa OAC e só `media/*` é servido.
- **CA2** Dado uma URL de mídia sem assinatura, com assinatura adulterada ou vencida, quando acesso pelo CloudFront, então recebo 403 (teste de fumaça pós-apply). `[PERM-16]`
- **CA3** Dado o lifecycle, quando reviso, então `incoming/` expira em 1 dia e versões antigas em 7 dias, coerente com a política de privacidade.

**7.5 Segredos e IAM mínimo (completo)**
- **CA1** Dado o código Terraform, `tfvars`, task definitions, `eas.json` e `EXPO_PUBLIC_*`, quando o gitleaks e uma revisão rodam, então nenhum segredo aparece.
- **CA2** Dado as roles, quando reviso, então cada task só acessa os ARNs listados no `infra.md` §6.5 e o deploy usa OIDC restrito à `main`, sem chave de longa duração.
- **CA3** Dado o `trivy config`, quando roda, então não há achado crítico ou alto sem justificativa registrada.

---

## EX: Pendentes do PO, sem fase definida

Nenhuma destas entra em fase até o PO decidir. Estimativas para ajudar a decisão.

| # | História | Tarefas técnicas | Esp. | Pts | Decisão | Observação |
|---|---|---|---|---|---|---|
| X.1 | Como pessoa, quero denunciar uma publicação, comentário ou conta, para sinalizar abuso 🔶 **PO: D5** | tabela de denúncias, rota, tela, fila de moderação mínima (e-mail ou painel simples) | FS | 8 | D5 | a App Store exige (diretriz 1.2) em app com conteúdo de usuários |
| X.2 | Como pessoa, quero bloquear uma conta, para não ver nem ser vista por ela 🔶 **PO: D5** | tabela de bloqueios, efeito no feed, perfil, busca, comentários e conexão | FS | 8 | D5 | mexe no `AccessPolicyService`; melhor entrar antes ou junto da Fase 3 |
| X.3 | Como pessoa nova, quero confirmar meu e-mail, para provar que o endereço é meu 🔶 **PO: D6** | token de verificação, envio por SES, bloqueio parcial até confirmar | FS | 5 | D6 | compartilha o serviço de e-mail com 1.10 |
| X.4 | Como pessoa, quero redefinir a senha (= 1.10) 🔶 **PO: D6** | ver 1.10 | FS | – | D6 | contada em 1.10 |
| X.5 | Como pessoa, quero entrar com e-mail ou @ (como no protótipo) 🔶 **PO: D14** | segunda chave de login | B | 2 | D14 | recomendação da arquitetura: só e-mail |
| X.6 | Como criador, quero trocar meu tipo de conta 🔶 **PO: D17** | migração do grafo, remoção do trigger | FS | 3+ | D17 | recomendação: não na v1 |

### Critérios de aceite (QA): EX (provisórios, valem se o PO aprovar)

**X.1 Denunciar (resumido)**
- **CA1** Dado um post, comentário ou perfil visível para mim, quando denuncio, então a denúncia é registrada e a pessoa denunciada não é avisada; denunciar algo que não vejo → 404.

**X.2 Bloquear (completo, permissões)**
- **CA1** Dado que A bloqueia B, quando B consulta perfil, posts, comentários ou a busca (se A for criador), então recebe o mesmo 404 de conteúdo inexistente.
- **CA2** Dado o bloqueio, quando B tenta seguir A (criador) ou se conectar com A (proximidade e QR), então é recusado com a mensagem genérica, sem revelar o bloqueio.
- **CA3** Dado uma conexão ou follow existente, quando A bloqueia B, então o vínculo é desfeito e os contadores dos dois são ajustados.
- **CA4** Dado o canário (PERM-10), quando roda com bloqueios no seed, então a lista de bloqueados também nunca sai para ninguém além do dono.

**X.3 Confirmar e-mail (resumido)**
- **CA1** Dado um cadastro, quando confirmo pelo link, então a conta fica verificada; link vencido ou reutilizado é recusado.

**X.5 Login por e-mail ou @ (resumido)**
- **CA1** Dado login por @, quando o @ não existe ou a senha está errada, então a resposta é idêntica (não vira oráculo de @ pessoal).

**X.6 Trocar tipo de conta (resumido)**
- **CA1** Se aprovada: dado a troca, quando concluída, então conexões, follows e posts seguem a regra decidida e os testes PERM continuam verdes.

## Perguntas novas levantadas neste backlog

1. **Busca por @ de conta pessoal (3.2)**: a especificação pede explicar que contas pessoais só se conectam ao vivo quando a pessoa digita o @ de uma conta pessoal. Se a mensagem só aparecer nesse caso, ela confirma que a conta existe. Recomendação: mostrar a dica sempre que a busca não encontrar criador.
2. **Bloqueio (X.2)**: se aprovado, deve entrar até a Fase 3, porque altera as regras de visibilidade testadas ali.
3. **Feed antes de seguir criadores (2.5 × 3.3)**: a Fase 2 só consegue testar o feed com conexões criadas por seed, porque seguir chega na Fase 3 e conectar na Fase 4. Os testes da Fase 2 usam fixtures de banco; a verificação de ponta a ponta no app fica completa na Fase 4.
