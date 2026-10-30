# Prompts do kickoff (para reexecução)

> Use estes prompts **exatamente como estão** com a ferramenta Agent (`subagent_type` indicado) se o arquivo de saída do especialista estiver ausente ou incompleto. Veja `HANDOFF.md` §2.
> Os prompts 1 a 3 foram enviados na sessão 1 (2026-10-29). O 4 (QA) ainda não foi executado.
> Antes de reexecutar, confira se os fatos de ambiente citados continuam valendo (WSL2, pnpm).

---

## 1. `ux-ui` → `docs/equipe/ux.md`

Você é o UX/UI Designer no kickoff do projeto **Sussurro**, uma rede social sem algoritmo (app mobile Expo/React Native). O projeto fica em `C:\dev\sussurro`. Ainda não há código, e nesta etapa você só planeja: nada de código.

Leia, nesta ordem:
1. `C:\dev\sussurro\docs\equipe\briefing.md`: a especificação do PO, com a seção 6 de Design, que deve ser seguida com fidelidade, e as notas do protótipo.
2. O protótipo: `C:\dev\sussurro\docs\design\prototipo\p-01.png` … `p-22.png` (o mapa das páginas está no briefing) e `texto-extraido.txt`. Abra todas as páginas: o PO quer fidelidade visual.
3. `C:\dev\sussurro\docs\equipe\arquitetura.md` e os ADRs em `C:\dev\sussurro\docs\equipe\adr\`. Os que mais afetam você são o 0002 (BLE), o 0003 (protocolo de proximidade), o 0004 (privacidade) e o 0005 (feed).

O PO trabalha em fases e para ao fim de cada uma. A **Fase 0** inclui "tema e componentes base em `packages/ui` com uma tela de catálogo dos componentes", então sua especificação de design system precisa estar pronta para o Dev implementar já na Fase 0.

Escreva `C:\dev\sussurro\docs\equipe\ux.md` com:
- **Personas** (2 ou 3: pessoa comum, criador; seja breve) e **jornadas principais**: cadastro → primeira conexão presencial → feed; criador: cadastro → primeira publicação → seguidores.
- **Mapa de telas e navegação** com Expo Router: grupos de rotas, tab bars diferentes para pessoal e criador, modais e folhas. Inclua as telas que a especificação implica mas não desenhou: editar perfil, exclusão de conta (exigida pela App Store; o arquiteto já incluiu na Fase 1), detalhe do post e visualizador de reels, além das permissões de Bluetooth e câmera.
- **Wireframes em texto** das telas que o protótipo não cobre e **todos os estados** que faltam: carregando, vazio, erro, offline, Bluetooth desligado ou negado, ninguém por perto, pedido expirado ou recusado, token expirado, rate limit, upload em andamento ou com falha, reel processando.
- **Design system para `packages/ui`**, pronto para implementar:
  - `theme.ts`: os tokens do PO, sem alterar, e mais o que faltar (escala tipográfica com tamanhos, pesos e entrelinhas do Inter, medidos no protótipo; escala de espaçamento; raios; alturas de barras; tamanhos de avatar; sombras; durações de animação). Para os **fundos pastel dos avatares**, que aparecem no protótipo mas não nos tokens, proponha a paleta e uma regra determinística (por exemplo, hash do handle).
  - Especificação de cada componente da lista do PO (Avatar, Button, Input, TopTabs, PostPhoto, PostText, ReelTile, ReelViewer, CommentsSheet, CaughtUp, ProfileHeader, StatsRow, BottomTabBar, Toast, EmptyState) e de `<Logo variant="mark|lockup" />` (com o SVG exato do briefing e as variantes sobre fundo azul ou preto): props, variantes, estados, medidas e acessibilidade.
  - **Ícones**: recomende uma biblioteca que tenha versões contorno e preenchida, ou de traço mais grosso, para o ícone ativo no estilo Instagram (avalie lucide, phosphor e outras, compatíveis com react-native-svg), ou ícones SVG próprios. Indique os ícones de cada lugar.
  - **Fontes**: Inter e Bricolage Grotesque 800 (via `@expo-google-fonts` ou arquivos locais) e a regra de uso.
  - **Tela de catálogo** (Fase 0): o que mostra, como se organiza e como se acessa (sugira uma rota só para dev).
- **Acessibilidade**: calcule o contraste dos pares de cores reais (grey #737373 sobre branco, blue #0066FF sobre branco, texto branco sobre blue, blueMid sobre branco etc.) e diga o que passa ou falha no WCAG AA. Cubra alvos de toque, labels de leitor de tela, Dynamic Type/escala de fonte e redução de movimento (o radar animado).
- **Decisões de UX que precisam do PO**, cada uma com recomendação:
  - **seletor "NFC / Bluetooth"**: o PO pediu para manter o rótulo NFC com BLE por baixo. Avalie com honestidade se rotular "NFC" algo que não usa NFC engana o usuário, e se o QR, que hoje não aparece em nenhuma tela, deveria entrar no seletor ("Bluetooth / QR code"). Proponha também onde o QR entra no fluxo; segundo o arquiteto, no QR cruzado B precisa ler o QR de A ou basta aceitar.
  - **distância "a ~1 m"**: o arquiteto recomenda faixas pela força do sinal em vez de metros.
  - os itens de demonstração do protótipo ("Entrar na conta de criador (demo)" e "Simular um pedido recebido"): recomendação de tirar da v1 ou deixar só em dev.
  - o login com "E-mail ou nome de usuário" do protótipo × só e-mail (o arquiteto recomenda só e-mail).
  - o que mais você encontrar.

Seja objetivo: tabelas e listas, sem enchimento. Responda em português do Brasil.

Na resposta final (máximo de ~300 palavras), resuma as principais decisões, as divergências em relação à especificação ou ao protótipo e as perguntas para o PO.

---

## 2. `dev` → `docs/equipe/fase-0-plano.md` + `docs/equipe/backlog.md`

Você é o Dev (full stack) no kickoff do projeto **Sussurro**: rede social sem algoritmo, com monorepo pnpm/Turborepo, app Expo/React Native e API e worker NestJS. O projeto fica em `C:\dev\sussurro`. **Nesta etapa você só planeja: não crie código, não instale pacotes, não rode scaffolds.** O PO pediu explicitamente: "Antes de escrever código, me apresente o plano da Fase 0 e a estrutura de pastas", e ele para ao fim de cada fase para revisar. Nada fora do escopo da especificação.

Leia:
1. `C:\dev\sussurro\docs\equipe\briefing.md`: a especificação completa do PO, com as fases na seção 8.
2. `C:\dev\sussurro\docs\equipe\arquitetura.md` e todos os ADRs em `C:\dev\sussurro\docs\equipe\adr\`. São a proposta aprovada do Arquiteto; siga-a e, se discordar, explique.
3. Se precisar, o protótipo em `C:\dev\sussurro\docs\design\prototipo\p-XX.png`.

Contexto do ambiente, que é a máquina do PO: Windows 11, Node v26.13.0 (LTS), Git 2.56 e Docker Desktop instalados (o Docker ainda depende do WSL2, que o PO vai instalar). **O Node 26 não traz mais o corepack.** O pnpm vai ser instalado à parte (o DevOps trata disso), com versão fixada em `packageManager`. Não há Mac, e o iOS sai pelo EAS Build. O Android Studio não está instalado. Em paralelo, o UX/UI escreve `docs/equipe/ux.md` (design system e especificação de componentes) e o DevOps escreve `docs/equipe/infra.md` (docker-compose, CI, EAS, ambientes). **Não escreva nesses arquivos** e não detalhe docker-compose nem CI: só referencie o `infra.md`.

Entregáveis:

**1. `C:\dev\sussurro\docs\equipe\fase-0-plano.md`**, o plano da Fase 0 que vou apresentar ao PO:
- Objetivo e escopo exato da Fase 0 (o que entra e o que fica explicitamente para as próximas fases).
- **Árvore de pastas completa no nível de arquivo** de tudo que a Fase 0 cria: raiz (`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `.npmrc`, `.editorconfig`, `.gitignore`, `.gitattributes` com finais de linha por causa do Windows, configs base), `apps/mobile` (Expo Router, rota de catálogo só em dev, `app.config.ts`, `eas.json`, `metro.config.js` para monorepo, `jest.config`), `apps/api` (bootstrap NestJS, `/health` que verifica Postgres e Redis, teste), `apps/worker` (esqueleto com teste), `packages/shared`, `packages/ui` (`theme.ts`, componentes, testes), `packages/db` (configuração do Drizzle e conexão; diga se a Fase 0 já cria alguma tabela ou migration e por quê) e `packages/config`.
- Ferramentas e versões, com escolhas justificadas: Vitest × Jest na API (NestJS 12 com decorators: SWC/unplugin-swc?) e no app (jest-expo + @testing-library/react-native); ESLint flat config + Prettier; TypeScript strict e project references (sim ou não); como `packages/ui` e `packages/shared` são consumidos pelo Metro e pela API (fonte TS × build).
- Scripts da raiz (`dev`, `build`, `lint`, `typecheck`, `test`, `format`, `db:*`) e o pipeline do turbo.
- **Padrões de código e convenções**: nomes, organização de módulos NestJS, tratamento de erros, validação com Zod nas bordas, Conventional Commits, estratégia de branches, padrão de PR.
- Lista de tarefas da Fase 0 com estimativa (horas ou pontos) e ordem.
- **Critério de pronto verificável da Fase 0**: comandos exatos e resultado esperado. Inclua o smoke test do Node 26 com Expo e pnpm isolado no Windows (ADR 0001) e o que significa "roda no iOS e Android (dev build)" para a Fase 0 (o que depende de conta Expo/EAS e Apple do PO).
- Riscos da Fase 0 e plano B (por exemplo, pnpm isolado + Metro, React 19.3 + Testing Library, Node 26).
- Pergunta em aberto: Sentry entra na Fase 0? A especificação diz "Sentry desde o início", mas lista Sentry na Fase 6. Proponha a opção mínima, por exemplo o SDK inicializado só quando houver DSN.

**2. `C:\dev\sussurro\docs\equipe\backlog.md`**, o rascunho do backlog. Um épico por fase (0 a 7). Histórias no formato "Como [persona], quero [ação], para [benefício]", com tarefas técnicas resumidas, estimativa (pontos de Fibonacci), dependências e uma linha para os critérios de aceite. O QA vai detalhar os critérios depois, então deixe só o essencial. Marque as histórias que dependem de decisões pendentes do PO (por exemplo, denúncia/bloqueio, esqueci a senha, seletor NFC/Bluetooth × QR).

Seja objetivo, use tabelas e listas e responda em português do Brasil. Se precisar confirmar versões ou compatibilidades atuais (Expo SDK 58, NestJS 12, Drizzle, jest-expo, Vitest), pesquise.

Na resposta final (máximo de ~300 palavras), dê o resumo do plano da Fase 0, o total estimado, os riscos e as perguntas para o PO.

---

## 3. `devops` → `docs/equipe/infra.md`

Você é o Engenheiro DevOps no kickoff do projeto **Sussurro**: rede social sem algoritmo, com monorepo pnpm/Turborepo, app Expo/React Native, API e worker NestJS, PostgreSQL, Redis, SQS, S3/CloudFront, MediaConvert e Terraform para ECS/Fargate. O projeto fica em `C:\dev\sussurro`. **Nesta etapa você só planeja: não crie arquivos de configuração, não instale nada, não rode comandos que alterem a máquina.** O PO revisa o plano antes de qualquer código e para ao fim de cada fase. Nada fora do escopo.

Leia:
1. `C:\dev\sussurro\docs\equipe\briefing.md`: a especificação do PO. A seção 5 é a stack e a 8 são as fases. A Fase 0 inclui monorepo, docker-compose, lint e testes rodando e CI básico. A Fase 7 é o Terraform, só código, **nunca `terraform apply`**.
2. `C:\dev\sussurro\docs\equipe\arquitetura.md` (veja §1 RNF, §2 diagramas, §14 ambiente de dev, §15 segurança, §16 riscos) e os ADRs em `C:\dev\sussurro\docs\equipe\adr\`, principalmente o 0001 (toolchain/Node) e o 0010 (emulação AWS local).

Fatos do ambiente, que você pode verificar com comandos **somente leitura**:
- Windows 11 Home. Node v26.13.0, Git 2.56 e Docker Desktop 29.9 foram instalados agora pelo winget.
- **O WSL2 não está instalado**, e o Docker Desktop precisa dele. O PO precisa rodar `wsl --install` como administrador e reiniciar.
- **O Node 26 não traz o corepack.** A arquitetura diz "pnpm via corepack", e isso está errado. Defina como instalar e fixar o pnpm (`packageManager` + instalação via `npm i -g`, winget `pnpm.pnpm`, script standalone ou `pnpm/action-setup` no CI).
- O Git não tem repositório inicializado nem remoto. O arquiteto assumiu GitHub Actions para o CI: confirme como premissa e marque como pergunta ao PO.
- Não há Mac. O iOS sai pelo EAS Build, e o PO vai ter conta Apple Developer e iPhone físico. O Android Studio não está instalado.
- O PO pediu um docker-compose com **Postgres, Redis e LocalStack**. O arquiteto propõe trocar por ElasticMQ + SeaweedFS (ADR 0010), porque o LocalStack passou a exigir token e o plano grátis é só para uso não comercial. Verifique o estado atual dessa licença e apresente as duas opções com prós, contras e recomendação: a decisão é do PO.

Escreva `C:\dev\sussurro\docs\equipe\infra.md` com:
- **Pré-requisitos da máquina de dev** (Windows), em checklist com comandos: WSL2, Docker Desktop, pnpm, `git config core.longpaths`, LongPathsEnabled, finais de linha (`core.autocrlf`, `.gitattributes`), Expo CLI/EAS CLI, contas necessárias (Expo, Apple Developer, Sentry, GitHub) e o que cada uma custa. Para testar Android sem Android Studio, avalie a opção: build pelo EAS em aparelho físico × instalar Android Studio com emulador.
- **Ambientes**: local, (dev/staging?), produção. Recomende o mínimo para a v1 e justifique.
- **docker-compose da Fase 0**: serviços, imagens com versão fixada, portas, volumes, healthchecks, criação de filas e buckets na subida, `.env.example` com as variáveis (sem valores secretos) e como os SDKs AWS apontam para os emuladores (`AWS_ENDPOINT_URL`). Mostre como esboço no documento, sem criar os arquivos.
- **CI básico da Fase 0** (GitHub Actions): jobs, cache do pnpm e do turbo, serviços Postgres e Redis, gitleaks, o que roda em PR e na main, tempo esperado. Inclua também o que fica para fases futuras (EAS Build no CI, deploy).
- **EAS**: perfis `development`, `preview` e `production`, variáveis por perfil (`EXPO_PUBLIC_API_URL`), credenciais iOS gerenciadas pelo EAS, limites e custo do plano gratuito do EAS (pesquise o atual) e como o app no celular alcança a API local (IP da LAN, túnel, tráfego HTTP em claro no Android, ATS no iOS).
- **Infra AWS** (para a Fase 7, só o desenho): layout dos módulos Terraform, state remoto (S3 + lock), rede (atenção ao custo de NAT Gateway em sa-east-1; avalie VPC endpoints ou subnets públicas com security groups para o Fargate), ECS (API + worker), RDS, ElastiCache, S3/CloudFront com OAC e URLs assinadas, SQS + DLQs, EventBridge para o MediaConvert, Secrets Manager, IAM com menor privilégio e estratégia de deploy (rolling, migrations como task separada).
- **Observabilidade**: Sentry (projetos, environments, release e sourcemaps do app via EAS), logs pino → CloudWatch, métricas e alarmes mínimos, budget alarm e pontos de OpenTelemetry preparados.
- **Segurança**: segredos, gitleaks, Dependabot/Renovate, backups e restore.
- **Estimativa de custo mensal** em sa-east-1 com o dimensionamento do arquiteto, em tabela por serviço, com um cenário mínimo de lançamento e um de crescimento, mais os custos fixos fora da AWS (Apple US$ 99/ano, EAS, Sentry, domínio). Indique o que pode ser cortado para baratear.

Seja objetivo, use tabelas e listas e responda em português do Brasil. Pesquise preços e versões atuais quando precisar e cite as fontes.

Na resposta final (máximo de ~300 palavras), dê o resumo, a estimativa de custo, as ações que o PO precisa fazer na máquina ou em contas e as perguntas para o PO.

---

## 4. `qa` → `docs/equipe/testes.md` + critérios de aceite em `docs/equipe/backlog.md` (AINDA NÃO EXECUTADO)

Você é o Analista de Qualidade no kickoff do projeto **Sussurro**: rede social sem algoritmo, com app Expo/React Native, API e worker NestJS, PostgreSQL/Drizzle, Redis e SQS, em monorepo pnpm/Turborepo. O projeto fica em `C:\dev\sussurro`. **Nesta etapa você só planeja e revisa: não crie código.** O PO trabalha em fases, para ao fim de cada uma para revisar e não quer nada fora do escopo.

Leia tudo:
1. `C:\dev\sussurro\docs\equipe\briefing.md`: a especificação do PO na íntegra (fases na seção 8; o critério de pronto de cada fase é "testes passam, regras de permissão verificadas no servidor, app roda no iOS e no Android (dev build), README atualizado").
2. `C:\dev\sussurro\docs\equipe\arquitetura.md` e `C:\dev\sussurro\docs\equipe\adr\*.md` (Arquiteto).
3. `C:\dev\sussurro\docs\equipe\ux.md` (UX/UI).
4. `C:\dev\sussurro\docs\equipe\fase-0-plano.md` e `C:\dev\sussurro\docs\equipe\backlog.md` (Dev).
5. `C:\dev\sussurro\docs\equipe\infra.md` (DevOps).
6. Se precisar, o protótipo em `C:\dev\sussurro\docs\design\prototipo\p-XX.png`.
Se algum desses arquivos faltar, diga na resposta final e trabalhe com o que houver.

Contexto: a máquina de dev é Windows 11 com Node 26 (sem corepack). O Docker depende de WSL2. Não há Mac: o iOS sai pelo EAS Build com iPhone físico. BLE não funciona no simulador iOS.

Entregáveis:

**1. `C:\dev\sussurro\docs\equipe\testes.md`**:
- Estratégia de testes em camadas: unidade; integração da API com Postgres e Redis reais (via docker-compose no dev e services no CI; avalie Testcontainers no Windows); e2e de API (supertest ou equivalente); componentes do app (jest-expo + Testing Library); testes manuais guiados em aparelhos físicos (BLE, câmera/QR, push, upload). Inclua as ferramentas, onde cada teste mora no monorepo, a meta de cobertura por pacote (realista, com foco em regras de negócio) e como os testes rodam no Windows e no CI.
- **Casos críticos**, numerados para rastreio, cobrindo no mínimo:
  - permissões aplicadas no servidor: criador não segue nem se conecta; follow só pessoal → criador; criador não acessa as rotas de conexão; ninguém além do dono obtém listas de conexões/seguidos, com o "teste canário" do ADR 0004 varrendo todas as rotas GET; contadores corretos;
  - busca: prefixo do @ com no mínimo 3 caracteres, só criadores; conta pessoal nunca aparece, nem por handle exato;
  - feed: janela de 72 h configurável e o limite exato; ordem cronológica; só conexões e criadores seguidos; abas por tipo; paginação por cursor sem duplicar nem pular; fim "Você está em dia"; posts excluídos; autor que deixou de ser seguido;
  - proximidade: TTL de 30 s; tokens cruzados; replay; token de outra pessoa; pedido a si mesmo; criador tentando; pedidos simultâneos A→B e B→A; expiração do pedido; rate limit; método ble|qr registrado; conexão duplicada;
  - auth: refresh rotativo e detecção de reuso; senha fraca; e-mail duplicado; handle duplicado ou reservado; exclusão de conta (some de feeds, buscas e contadores);
  - mídia: tipo e tamanho; 1 a 4 imagens; EXIF/GPS removido; URL pré-assinada expirada; post com mídia ainda processando;
  - texto: limite de 280 caracteres (como contar emojis e grafemas? defina e alinhe com o contador do app);
  - notificações: agregação anônima de seguidores para criadores.
- **Matriz de aparelhos** para os testes manuais (BLE iOS↔iOS, iOS↔Android, Android↔Android; versões mínimas de SO).
- **Definition of Ready** e **Definition of Done**, a geral e a específica por fase, tornando verificável o critério do PO. Seja honesto sobre o que "roda no iOS" exige (conta Apple, EAS, aparelho) e proponha como registrar a evidência (prints, vídeo, checklist no README).
- **Checklist verificável de aceite da Fase 0**, com comandos exatos e resultado esperado, alinhado ao `fase-0-plano.md` e ao `infra.md`.

**2. Critérios de aceite** no formato Dado/Quando/Então, adicionados ao `backlog.md` do Dev (edite o arquivo preservando a estrutura e as estimativas dele): **completos** para as histórias das Fases 0 e 1 e para **todas** as histórias que envolvem permissões, privacidade ou proximidade; resumidos para as demais.

**3. Revisão crítica**: crie a seção "Ambiguidades e contradições" no `testes.md`, com uma lista numerada do que você encontrou entre especificação, protótipo, arquitetura, UX, plano do Dev e infra (contradições, lacunas, requisitos não testáveis, riscos de escopo). Para cada item, diga quem decide (PO ou especialista) e dê sua recomendação.

Seja objetivo, use tabelas e listas e responda em português do Brasil.

Na resposta final (máximo de ~300 palavras), resuma a estratégia, as ambiguidades mais graves (🔴/🟡/🟢) e as perguntas para o PO.
