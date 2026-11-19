# Infraestrutura e DevOps do Sussurro (v1)

> Autor: DevOps. Data: 2026-10-29. Status: **proposta para revisão do PO**. Nada aqui foi criado nem instalado.
> Entradas: `briefing.md` (§5 stack, §8 fases), `arquitetura.md` (§1, §2, §14 a §16), ADRs 0001, 0006, 0009, 0010 e 0011.
> Os preços e as versões foram consultados em 2026-10-29. As fontes estão no fim do documento.

## 0. Resumo

| Tema | Proposta |
|---|---|
| Máquina de dev | WSL2 + Docker Desktop. pnpm 12 instalado via `npm i -g` e fixado em `packageManager`. Caminhos longos ligados. LF em todo o repositório. **A máquina tem 7,7 GB de RAM**, o que pesa contra o emulador Android e contra o LocalStack. |
| Ambientes v1 | **local + CI + produção**. Staging não entra na v1: o Terraform fica pronto para criá-lo quando houver usuários reais. |
| Emulação AWS local | **Decisão do PO (D2).** Recomendo ElasticMQ + SeaweedFS. O LocalStack exige conta e token, e o plano gratuito proíbe uso comercial. |
| CI | GitHub Actions (**premissa, D16**): gitleaks, lint/typecheck e testes com Postgres e Valkey como services. Leva cerca de 4 a 6 min. |
| App | EAS com perfis `development`, `preview` e `production`. O plano Free cobre a Fase 0 (15 builds Android + 15 iOS por mês). |
| AWS (Fase 7) | ECS Fargate ARM em **subnets públicas sem NAT Gateway**, RDS PG 18 Multi-AZ, Valkey, S3 + CloudFront (OAC + URL assinada), SQS + DLQ, EventBridge → SQS para o MediaConvert. |
| Custo AWS/mês | **Lançamento: ~US$ 285** (dimensionamento do arquiteto). Versão enxuta: **~US$ 155**. Crescimento (10×): **~US$ 975**. Fora da AWS: **~US$ 53/mês** no lançamento. |

---

## 1. Pré-requisitos da máquina de dev (Windows 11 Home)

Estado verificado em 2026-10-29: WSL não instalado. `LongPathsEnabled = 0`. `core.longpaths` não configurado. `core.autocrlf = true` (vem do gitconfig de sistema do Git for Windows). 7,7 GB de RAM, i5-12450H e 144 GB livres no C:.

### 1.1 Checklist (o PO executa, na ordem)

| # | Item | Comando ou ação | Observação |
|---|---|---|---|
| 1 | **WSL2** | PowerShell **como administrador**: `wsl --install --no-distribution` | O Docker só precisa do kernel WSL2. Se o PO quiser um Ubuntu (útil para `eas build --local` Android no futuro), use só `wsl --install`. |
| 2 | **Caminhos longos (SO)** | No mesmo PowerShell admin: `New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force` | Gradle e `node_modules` isolado do pnpm geram caminhos maiores que 260 caracteres. |
| 3 | Reiniciar | Uma única reinicialização vale para os itens 1 e 2 | |
| 4 | Conferir o WSL | `wsl --update` e depois `wsl --status` (esperado: "Versão padrão: 2") | Se der erro de virtualização, ative VT-x no BIOS. |
| 5 | **Limitar a RAM do WSL** | Criar `%UserProfile%\.wslconfig` com `[wsl2]`, `memory=3GB`, `swap=4GB` | Com 7,7 GB, sem limite o WSL pode tomar metade da RAM e deixar o Metro e o VS Code lentos. A stack local (§3) cabe em menos de 1 GB. |
| 6 | **Docker Desktop** | Abrir uma vez, aceitar os termos e confirmar "Use the WSL 2 based engine". Depois rodar `docker run --rm hello-world` | É gratuito para uso pessoal e para empresas com menos de 250 pessoas **e** menos de US$ 10 milhões de faturamento. |
| 7 | **pnpm** | `npm install -g pnpm@12.13.0` e depois `pnpm -v` | Veja §1.2. |
| 8 | **Git: caminhos longos** | `git config --global core.longpaths true` | |
| 9 | **Git: finais de linha** | `git config --global core.autocrlf false` | O `.gitattributes` (§1.3) passa a mandar. Isso evita CRLF em scripts que rodam dentro de containers Linux. |
| 10 | Git: identidade | `git config --global user.name "…"` e `git config --global user.email "…"` | Antes do primeiro commit, que só acontece com pedido do PO. |
| 11 | **EAS CLI** | Não instalar globalmente nem como dependência do app (o `expo-doctor` reprova `eas-cli` no `package.json`). Usar `pnpm dlx eas-cli@27.1.0 <comando>` (ex.: `login`, `build`) | A versão fica fixada no README. `eas.json` usa `cli.version` compatível. _(Corrigido na consolidação da Fase 0.)_ |
| 12 | **Expo CLI** | Nada a instalar. Vem com o pacote `expo` (`pnpm --filter mobile exec expo start`) | O `expo-cli` global foi descontinuado. |
| 13 | **Firewall** (para o celular alcançar o PC) | PowerShell admin: `New-NetFirewallRule -DisplayName "Sussurro dev" -Direction Inbound -Protocol TCP -LocalPort 3000,8081,8333 -Profile Private -Action Allow`. Marque a rede Wi-Fi de casa como **Privada** | 3000 = API, 8081 = Metro, 8333 = S3 local (upload direto do app). |
| 14 | iPhone | Ajustes → Privacidade e Segurança → **Modo de Desenvolvedor**: ligar (aparece depois do primeiro dev build instalado) | Exigido para rodar dev builds no iOS 16 ou mais recente. |

Para conferir tudo depois, o Dev pode criar um `pnpm doctor` (script somente leitura) que verifica Node 26, pnpm 12, Docker rodando, `core.longpaths` e o registro de caminhos longos. É sugestão para a Fase 0.

### 1.2 Como instalar e fixar o pnpm (o Node 26 não traz corepack)

| Opção | Prós | Contras |
|---|---|---|
| **`npm i -g pnpm@12.13.0`** (recomendada) | Usa o npm que vem com o Node 26. Um comando. A mesma versão no PC, no CI e no EAS. | Atualizar exige repetir o comando (o `packageManager` avisa quando a versão diverge). |
| winget `pnpm.pnpm` | Executável standalone, independente do Node. | A versão segue o winget, não o repositório. É fácil ficar com uma versão diferente da fixada. |
| Script standalone (`iwr https://get.pnpm.io/install.ps1 -useb \| iex`) | Não depende do Node. | Executa um script remoto. Prefiro evitar em máquina de dev. |
| `npm i -g corepack` + `corepack enable` | Mantém o que a arquitetura escreveu. | O corepack saiu do Node e seu futuro como pacote avulso é incerto. É uma peça a mais sem ganho. |

Como fixar:
- `package.json` raiz: `"packageManager": "pnpm@12.13.0"` (com o hash `+sha512…` que o próprio pnpm grava) e `"engines": { "node": ">=26.13 <27", "pnpm": ">=12.13 <13" }`. O `.npmrc` leva `engine-strict=true`.
- O pnpm lê o `packageManager` e, se a versão global for outra, baixa e usa a fixada (`managePackageManagerVersions`, ligado por padrão). **Confirmar no smoke test da Fase 0.**
- CI: `pnpm/action-setup@v6` **sem** o input `version`, para ler o `packageManager`.
- EAS: `"pnpm": "12.13.0"` e `"node": "26.13.0"` no perfil base do `eas.json`. Confirmar na Fase 0 que a imagem do EAS aceita o Node 26 (ADR 0001, portão de fallback para o Node 24).
- Escolhi a 12.13.0 (13/10/2026) em vez da 12.16.1 (27/10): ela tem mais de duas semanas de uso, o que é uma margem contra versões comprometidas na cadeia de suprimentos. O Dependabot propõe as atualizações.
- Segurança do pnpm (`pnpm-workspace.yaml`): `minimumReleaseAge: 1440` (não instala versões com menos de um dia) e `onlyBuiltDependencies` com a lista explícita de pacotes que podem rodar scripts de instalação (ex.: `esbuild`, `sharp`, `@sentry/cli`). O pnpm 10 ou mais recente já bloqueia scripts por padrão.

### 1.3 Finais de linha

`.gitattributes` (esboço):
```gitattributes
* text=auto eol=lf
*.{cmd,bat,ps1} text eol=crlf
*.{png,jpg,jpeg,gif,webp,pdf,ttf,otf,woff,woff2,mp4,mov,jar,keystore,p12} binary
```
O `.editorconfig` leva `end_of_line = lf`, e o Prettier, `endOfLine: "lf"`. Motivo: scripts de init montados em containers (ex.: `ready.d/init.sh` no caso do LocalStack) quebram com CRLF.

### 1.4 Testar Android sem Android Studio

| | **Build EAS em aparelho Android físico** (recomendado) | Android Studio + emulador |
|---|---|---|
| Instalação | Nenhuma. Instala o APK pelo link ou QR do EAS. | ~10 a 15 GB (SDK, imagens, Gradle) e configuração de JDK e `ANDROID_HOME`. |
| RAM | Zero no PC. | O emulador sozinho usa 2 a 4 GB. **Com 7,7 GB de RAM, junto com Docker, Metro e VS Code, fica inviável.** |
| NFC do Conectar (Fase 4e, ADR 0013; antes BLE) | Funciona (reader mode e HCE). | **Não funciona** (emulador não tem NFC real). |
| Câmera/QR, push | Real. | Câmera simulada. Push só com imagem Google Play. |
| Ciclo | Novo build só quando muda código nativo (~10 a 30 min na fila Free). Mudanças em JS chegam na hora pelo Metro. | Build local mais rápido, mas exige toda a toolchain nativa. |
| Custo | Consome 1 dos 15 builds Android grátis por mês. | Grátis. |

**Recomendação:** aparelho Android físico + dev build pelo EAS. O Android Studio só se tornaria útil para depurar código nativo Kotlin na Fase 4, e mesmo nesse caso o aparelho físico continua obrigatório. **Pergunta ao PO:** você tem um aparelho Android? A Fase 4 exige no mínimo um iPhone e um Android (e, idealmente, dois de cada).

### 1.5 Contas necessárias

| Conta | Para quê | Quando | Custo |
|---|---|---|---|
| **GitHub** | Repositório + Actions (CI) | Fase 0 | Free: repositório privado com 2.000 min/mês de Actions. **Atenção:** em repositório privado no plano Free não há branch protection (checks obrigatórios). O GitHub Pro custa US$ 4/mês. Veja as perguntas no §10. |
| **Expo** (EAS) | Builds iOS e Android, credenciais, Update e Push | Fase 0 | Free: 15 builds Android + 15 iOS por mês, fila de baixa prioridade, timeout de 45 min, Update até 1.000 MAU. Starter: US$ 19/mês. |
| **Apple Developer** | Dev build no iPhone, TestFlight e App Store | Fase 0 (para "roda no iOS") | US$ 99/ano. Pessoa física ou jurídica (a jurídica exige D-U-N-S e aparece como vendedora na loja). Decisão do PO. |
| **Sentry** | Erros do app, da API e do worker | Fase 0 com SDK desligado sem DSN (D4) ou Fase 6 | Developer: grátis (1 usuário, 5 mil erros/mês). Team: US$ 26/mês (anual) ou US$ 29 (mensal). |
| Google Play Console | Publicar o Android | Antes do lançamento (não é v1-Fase 0) | US$ 25, pagamento único. Contas pessoais novas precisam de **teste fechado com 12 testadores por 14 dias** antes da produção (confirmar a regra vigente). Isso entra no cronograma de lançamento. |
| AWS | Produção | **Só depois da Fase 7 e com autorização para `apply`** | Veja o §9. |
| Domínio | `api.` e `media.` com TLS | Antes do apply | .com.br: ~R$ 40/ano (registro.br). .app: ~US$ 15 a 20/ano. |

---

## 2. Ambientes

| Ambiente | Onde roda | Desde | Para quê | Custo |
|---|---|---|---|---|
| **local** | PC do PO: dependências no docker-compose; API, worker e Metro no host (hot reload) | Fase 0 | Desenvolvimento diário, celular na mesma rede Wi-Fi | US$ 0 |
| **CI** | GitHub Actions, efêmero | Fase 0 | Portão de qualidade de cada PR | US$ 0 (Free) |
| **produção** | AWS sa-east-1, Terraform `envs/prod` | Depois da Fase 7, **somente com apply autorizado pelo PO** | Usuários reais | §9 |
| staging | Mesmos módulos, `envs/staging` | **Fora da v1** | | ~US$ 120 a 160/mês (porte enxuto) ou ~US$ 5/dia se criado e destruído só para testar releases |

**Recomendação: local + CI + produção.** Justificativa:
- Antes do lançamento, a produção não tem usuários e serve de homologação. O perfil `preview` do app aponta para ela, com contas de teste.
- Uma equipe de uma pessoa com um app único não justifica pagar outra cópia da infraestrutura todo mês.
- O Terraform é modular, então criar o staging depois é só um `envs/staging/terraform.tfvars`. O gatilho para criá-lo é o primeiro destes: usuários reais em produção com migração de banco arriscada, uma segunda pessoa na equipe, ou exigência de teste de carga.

---

## 3. docker-compose (criado na Fase 0: `docker-compose.yml`)

> (atualizado em 2026-10-31) O compose existe desde a Fase 0, com a opção B (D2). A fonte da verdade é o `docker-compose.yml` da raiz; os esboços desta seção são a proposta original, e as diferenças estão em "Correções feitas na implementação" (§3.2). O CI usa o mesmo arquivo para os emuladores (jobs `test` e `images`, §4.1).

### 3.1 Decisão D2: LocalStack × ElasticMQ + SeaweedFS

Estado da licença do LocalStack em 2026-10-29 (página oficial de preços e termos):
- Desde março de 2026, a imagem exige **conta e `LOCALSTACK_AUTH_TOKEN`**, inclusive no CI.
- O plano **Hobby é grátis, mas proíbe uso comercial** ("The terms of the Hobby plan prohibit use for commercial purposes").
- O **Base** custa **US$ 39 por licença/mês** (anual) ou **US$ 45** (mensal). O Ultimate custa US$ 89 (anual). O CI fica sujeito à política de uso justo. A política de uso justo também diz que tokens pessoais não devem ser usados em pipelines compartilhados.

| Critério | **A. LocalStack** (pedido original do PO) | **B. ElasticMQ + SeaweedFS** (ADR 0010) |
|---|---|---|
| Licença e custo | Hobby só não comercial. Para o Sussurro (produto comercial): **Base, US$ 39 a 45/mês por dev**, mais o uso no CI | Apache-2.0. **US$ 0**, sem conta |
| Segredos | Token no `.env` local e como secret no CI (PRs de fork não recebem secrets) | Nenhum |
| Containers | 1 (S3 + SQS e outros) | 2 + 1 de init (cria o bucket) |
| RAM | Maior (runtime Python, ~0,5 a 1 GB) | ~100 a 200 MB no total. **Relevante com 7,7 GB de RAM** |
| Fidelidade à AWS | Alta e ampla | Boa no subconjunto que usamos (PUT pré-assinado, HEAD, GET, Delete, filas, DLQ, visibility timeout). **Validar no spike da Fase 0** |
| Offline | Valida o token na subida (comportamento offline a confirmar) | Funciona offline |
| MediaConvert/EventBridge | Não emulados no plano Base (o dev usa `PassthroughVideoProcessor` de qualquer jeito) | Não emulados (mesma solução) |
| Troca futura | | Só configuração: o código usa o AWS SDK v3 e endpoints vindos do ambiente |

**Recomendação: B (ElasticMQ + SeaweedFS)**, com o spike da Fase 0 como portão. Se o spike falhar em algo essencial, o plano B é o LocalStack Base pago. O código não muda, só o compose e o `.env`. A decisão é do PO.

### 3.2 Serviços (opção B)

| Serviço | Imagem (tag fixada) | Porta no host | Volume | Healthcheck | Função |
|---|---|---|---|---|---|
| `postgres` | `postgres:18.6-bookworm` | `127.0.0.1:5432` | `pgdata` (named) | `pg_isready -U sussurro -d sussurro` | Banco. O mesmo major do RDS (18). |
| `valkey` | `valkey/valkey:8.1-alpine` | `127.0.0.1:6379` | — (efêmero) | `valkey-cli ping` | Redis protocolo 7. O mesmo motor do ElastiCache for Valkey. |
| `elasticmq` | `softwaremill/elasticmq-native:1.7.1` | `127.0.0.1:9324` (SQS), `127.0.0.1:9325` (UI) | `./infra/local/elasticmq.conf` (somente leitura) | A imagem nativa não traz curl. Usar `service_started` + retry no SDK, ou trocar pela imagem JVM se for preciso healthcheck (validar no spike) | SQS. **As filas e DLQs são criadas pelo arquivo de configuração na subida.** |
| `seaweedfs` | `chrislusf/seaweedfs:4.48` | `0.0.0.0:8333` (S3) | `s3data` (named) + `./infra/local/s3.json` (credenciais locais) | `wget -q --spider http://127.0.0.1:9333/cluster/status` (validar) | S3. Comando: `server -s3 -s3.config=/etc/seaweedfs/s3.json -dir=/data`. **Precisa ser alcançável pelo celular** por causa do PUT pré-assinado. |
| `s3-init` | `amazon/aws-cli:2.38.5` | — | — | `restart: "no"`, `depends_on: seaweedfs: service_healthy` | Cria o bucket `sussurro-media` de forma idempotente (`s3api head-bucket \|\| s3api create-bucket`) e sai. |

Regras:
- Postgres, Valkey e ElasticMQ ficam presos a `127.0.0.1`, sem exposição na LAN. Só o S3 (8333) fica na LAN.
- Nada de bind mount do código, só volumes nomeados. Bind mount de NTFS para o WSL é lento.
- Os apps (API, worker, Metro) rodam no host com `pnpm dev`. Dockerfiles para API e worker ficam para a Fase 7 (deploy). Se o Dev os criar antes, o CI passa a fazer `docker build` de verificação.
- O compose usa `name: sussurro`. `docker compose up -d --wait` sobe tudo e espera os healthchecks.
- Tags fixadas no compose. O Dependabot (ecossistema `docker-compose`) propõe as atualizações. (atualizado em 2026-10-31) Desde o PR 4, tag **e** digest do índice multi-arquitetura (`tag@sha256:…`, amd64 e arm64), e o Dependabot atualiza os dois juntos. Os services do `ci.yml` repetem os do Postgres e do Valkey; o Dependabot não os atualiza, e o job `quality` falha se divergirem do compose.

**Correções feitas na implementação (Fase 0, revisão estática sem Docker; validar com F0-DC-01/02/06):**
- `seaweedfs`: o comando `server` escuta só no IP do container quando não recebe `-ip.bind` (código do SeaweedFS 4.48), e o healthcheck em `127.0.0.1:9333` nunca passaria. O comando ganhou `-ip=seaweedfs -ip.bind=0.0.0.0` (padrão do compose oficial do SeaweedFS), e o healthcheck passou para `wget -q --spider http://127.0.0.1:8333/healthz`, porque o gateway S3 é o último componente a subir.
- `s3-init` × `--wait`: o Compose 5.x só aceita, no `up --wait`, um serviço que termina se outro depender dele com `service_completed_successfully`. Sem isso, falha com "container sussurro-s3-init-1 exited (0)". O `elasticmq` passou a depender do `s3-init` com essa condição. Não há dependência real entre os dois, é só para o `--wait`. O `s3-init` também tenta 10 vezes, com 2 s entre as tentativas, e lê o bucket de `S3_BUCKET_MEDIA`.
- `elasticmq`: a imagem é alpine e tem o `wget` do busybox, então um healthcheck é possível (ex.: `wget -q -O /dev/null "http://127.0.0.1:9324/?Action=ListQueues"`). Fica para quando o CI usar SQS (Fase 2), depois de validado com Docker.
- Spike F0-DC-07: `pnpm spike:aws` (`infra/local/spike-aws.mts`).

`infra/local/elasticmq.conf` (esboço):
```hocon
include classpath("application.conf")
node-address { protocol = http, host = localhost, port = 9324, context-path = "" }
rest-sqs { enabled = true, bind-port = 9324, bind-hostname = "0.0.0.0" }
queues {
  media-jobs     { defaultVisibilityTimeout = 120 seconds, deadLettersQueue { name = "media-jobs-dlq", maxReceiveCount = 3 } }
  media-jobs-dlq { }
  video-events   { defaultVisibilityTimeout = 60 seconds,  deadLettersQueue { name = "video-events-dlq", maxReceiveCount = 3 } }
  video-events-dlq { }
  push           { defaultVisibilityTimeout = 60 seconds,  deadLettersQueue { name = "push-dlq", maxReceiveCount = 3 } }
  push-dlq       { }
}
```

`docker-compose.yml` (esboço resumido):
```yaml
name: sussurro
services:
  postgres:
    image: postgres:18.6-bookworm
    environment: { POSTGRES_USER: sussurro, POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}, POSTGRES_DB: sussurro }
    ports: ["127.0.0.1:5432:5432"]
    volumes: [pgdata:/var/lib/postgresql]   # PG 18: o volume vai no diretório pai
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U sussurro -d sussurro"], interval: 5s, retries: 20 }
  valkey:
    image: valkey/valkey:8.1-alpine
    ports: ["127.0.0.1:6379:6379"]
    healthcheck: { test: ["CMD", "valkey-cli", "ping"], interval: 5s, retries: 20 }
  elasticmq:
    image: softwaremill/elasticmq-native:1.7.1
    ports: ["127.0.0.1:9324:9324", "127.0.0.1:9325:9325"]
    volumes: ["./infra/local/elasticmq.conf:/opt/elasticmq.conf:ro"]
  seaweedfs:
    image: chrislusf/seaweedfs:4.48
    command: server -s3 -s3.config=/etc/seaweedfs/s3.json -dir=/data
    ports: ["8333:8333"]
    volumes: [s3data:/data, "./infra/local/s3.json:/etc/seaweedfs/s3.json:ro"]
    healthcheck: { test: ["CMD-SHELL", "wget -q --spider http://127.0.0.1:9333/cluster/status"], interval: 5s, retries: 30 }
  s3-init:
    image: amazon/aws-cli:2.38.5
    depends_on: { seaweedfs: { condition: service_healthy } }
    environment: { AWS_ACCESS_KEY_ID: local, AWS_SECRET_ACCESS_KEY: local, AWS_REGION: sa-east-1 }
    entrypoint: ["/bin/sh","-c","aws --endpoint-url http://seaweedfs:8333 s3api head-bucket --bucket sussurro-media || aws --endpoint-url http://seaweedfs:8333 s3api create-bucket --bucket sussurro-media"]
    restart: "no"
volumes: { pgdata: {}, s3data: {} }
```

Variante LocalStack (se o PO escolher A): um serviço `localstack/localstack:2026.10.x` (tag mensal fixada na Fase 0), porta `127.0.0.1:4566` (S3 na LAN: `0.0.0.0:4566`), `SERVICES=s3,sqs`, `LOCALSTACK_AUTH_TOKEN=${LOCALSTACK_AUTH_TOKEN:?defina no .env}`, healthcheck `curl -f http://localhost:4566/_localstack/health`, e filas e bucket criados por `./infra/local/localstack/ready.d/init.sh` (com `awslocal`, LF obrigatório).

### 3.3 Como os SDKs AWS apontam para os emuladores

- O AWS SDK for JavaScript v3 lê **endpoints por serviço** do ambiente: `AWS_ENDPOINT_URL_SQS` e `AWS_ENDPOINT_URL_S3`. Com dois emuladores (opção B), cada serviço tem o seu. Com o LocalStack, basta `AWS_ENDPOINT_URL=http://localhost:4566`. **Em produção nenhuma dessas variáveis existe**, e o SDK usa a AWS real.
- O S3 local exige `forcePathStyle: true` (variável `S3_FORCE_PATH_STYLE`).
- **Pegadinha do upload direto:** a URL pré-assinada é gerada pela API, mas usada pelo **celular**. Se ela apontar para `localhost:8333`, o celular falha. Por isso há `S3_PUBLIC_ENDPOINT_URL=http://<IP-da-LAN>:8333`, usado **só para presign** (a API usa `AWS_ENDPOINT_URL_S3=http://localhost:8333` para `HEAD`/`GET`). A host faz parte da assinatura, então não dá para trocar depois.
- Leitura de mídia em dev: não há CloudFront. `MEDIA_URL_SIGNER=s3-presign` gera GET pré-assinado no SeaweedFS. Em produção, `cloudfront`.
- Credenciais locais são valores fictícios (`local`/`local`), aceitos pelos emuladores. Não são segredos.

### 3.4 `.env.example` (esboço, sem segredos)

Raiz (lido por API e worker; `apps/mobile` tem o próprio):
```dotenv
# --- geral ---
NODE_ENV=development
LOG_LEVEL=debug
API_HOST=0.0.0.0
API_PORT=3000
FEED_WINDOW_HOURS=72

# --- banco e redis (credencial só local, não é segredo) ---
POSTGRES_PASSWORD=sussurro
DATABASE_URL=postgres://sussurro:sussurro@localhost:5432/sussurro
REDIS_URL=redis://localhost:6379

# --- AWS (dev: emuladores; prod: vazio = AWS real com IAM role) ---
AWS_REGION=sa-east-1
AWS_ACCESS_KEY_ID=local
AWS_SECRET_ACCESS_KEY=local
AWS_ENDPOINT_URL_SQS=http://localhost:9324
AWS_ENDPOINT_URL_S3=http://localhost:8333
# Com LocalStack: troque as duas linhas acima por AWS_ENDPOINT_URL=http://localhost:4566 e preencha LOCALSTACK_AUTH_TOKEN
LOCALSTACK_AUTH_TOKEN=
S3_FORCE_PATH_STYLE=true
S3_PUBLIC_ENDPOINT_URL=http://192.168.0.10:8333   # IP do PC na LAN
S3_BUCKET_MEDIA=sussurro-media
SQS_QUEUE_MEDIA_JOBS=media-jobs
SQS_QUEUE_VIDEO_EVENTS=video-events
SQS_QUEUE_PUSH=push

# --- mídia ---
MEDIA_URL_SIGNER=s3-presign        # prod: cloudfront
CLOUDFRONT_DOMAIN=
CLOUDFRONT_KEY_PAIR_ID=
CLOUDFRONT_PRIVATE_KEY=            # prod: Secrets Manager
VIDEO_PROCESSOR=passthrough        # prod: mediaconvert
MEDIACONVERT_ROLE_ARN=

# --- auth (gerado pelo script de setup; nunca commitar) ---
JWT_ACCESS_SECRET=

# --- observabilidade ---
SENTRY_DSN=                        # vazio = Sentry desligado
SENTRY_ENVIRONMENT=local
SENTRY_TRACES_SAMPLE_RATE=0
OTEL_ENABLED=false

# --- push (Fase 6) ---
EXPO_ACCESS_TOKEN=
```

`apps/mobile/.env.example`:
```dotenv
EXPO_PUBLIC_API_URL=http://192.168.0.10:3000
EXPO_PUBLIC_SENTRY_DSN=
APP_VARIANT=development
```

"Um comando para rodar" (sugestão ao Dev): `pnpm setup` copia os `.env.example` que faltarem, gera `JWT_ACCESS_SECRET` aleatório, roda `docker compose up -d --wait` e as migrations. Depois, `pnpm dev`.

---

## 4. CI básico da Fase 0 (GitHub Actions)

**Premissa: GitHub + GitHub Actions (D16).** Ainda não há `git init` nem remoto. Criar o repositório e fazer o primeiro push é ação do PO, ou da equipe com pedido explícito.

```mermaid
flowchart LR
  PR[pull_request → main<br/>push → main] --> S[secrets<br/>gitleaks]
  PR --> Q[quality<br/>pnpm install · lint · typecheck · format:check]
  PR --> T[test<br/>vitest/jest + services<br/>postgres 18 · valkey 8.1]
  Q --> B[build<br/>turbo build api/worker/shared/ui]
  T --> OK{todos verdes}
  S --> OK
  B --> OK
  OK -.Fase 7.-> IMG[docker build → ECR<br/>OIDC]
  IMG -.-> MIG[ecs run-task migrate] -.-> DEP[ecs update-service<br/>rolling]
  OK -.Fase 6/7, manual.-> EAS[eas build --profile preview]
```

### 4.1 Workflow `ci.yml` (Fase 0)

| Item | Definição |
|---|---|
| Gatilhos | `pull_request` (para `main`) e `push` em `main`. `concurrency: ci-${{ github.ref }}` com `cancel-in-progress: true` em PRs. |
| Permissões | `permissions: contents: read` (mínimo). |
| Actions | `actions/checkout@v7`, `actions/setup-node@v7` (`node-version-file: .nvmrc`, `cache: pnpm`), `pnpm/action-setup@v6` (lê o `packageManager`), `actions/cache@v6`. **Fixadas por SHA do commit** com a tag em comentário; o Dependabot atualiza. |
| Cache | Store do pnpm via `setup-node cache: pnpm` (chave = hash do `pnpm-lock.yaml`). Turbo: `actions/cache` em `.turbo/cache`, chave `turbo-${{ runner.os }}-${{ github.sha }}` com `restore-keys: turbo-${{ runner.os }}-`. Remote cache da Vercel fica para depois, se o CI ficar lento. |
| Install | `pnpm install --frozen-lockfile`. |

| Job | Passos | Roda em |
|---|---|---|
| `secrets` | `checkout` com `fetch-depth: 0` + **gitleaks CLI** via `docker run ghcr.io/gitleaks/gitleaks:v8.30.1 git --redact -v` | PR e main |
| `quality` | install → `pnpm turbo run lint typecheck` → `pnpm format:check` → `pnpm --filter mobile exec expo-doctor` (não bloqueante na Fase 0). (atualizado em 2026-10-31) Logo depois do install, bloqueantes: `scripts/audit-exceptions.mjs` (§8.3) e a paridade das imagens dos services com o `docker-compose.yml` | PR e main |
| `test` | services `postgres:18.6-bookworm` e `valkey/valkey:8.1-alpine` com health options → install → `pnpm test` **e** `pnpm test:e2e` (migrations só a partir da Fase 1; filtros pelo nome completo `@sussurro/*`; resolvido na consolidação, A-24) (unidade + integração da API com `/health/ready` contra Postgres e Redis reais; jest-expo no app e no `ui`) | PR e main |
| `build` | `pnpm turbo run build --filter=!mobile` (API, worker, shared, ui, db) | PR e main |
| `infra` (Fase 7) | `terraform fmt -check`, `init` + `validate` das duas raízes (sem backend e sem credencial), `tflint` e `trivy config`. (atualizado em 2026-10-31, B6) O `.terraform.lock.hcl` das duas raízes está no Git (gerado pelo próprio job, run 41234942342), e o `init` usa `-lockfile=readonly`. Uma raiz sem lock ainda passa: o job gera o lock (`providers lock`, 5 plataformas) e o publica no artefato `terraform-lock` | PR e main |
| `changes` (B5) | Lista os arquivos do PR (`git diff HEAD^1 HEAD` no merge commit) e decide se o `images` roda. Só docs, `*.md`, `infra/` (menos `infra/local/`), testes, app e `ui` (menos os `package.json`), as exceções do gitleaks e do audit e alguns arquivos do `.github/` (`CODEOWNERS`, Dependabot e o modelo de PR) ficam de fora; qualquer outro caminho roda o `images`. (atualizado em 2026-11-19) Também decide se o `native` roda: módulos nativos (`apps/mobile/modules/`), `app.config.ts` e `package.json` do app, `package.json` da raiz, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `scripts/check-android-manifest.mjs` e o próprio `ci.yml` | PR |
| `images` (B5) | Em **ARM64 nativo** (`ubuntu-24.04-arm`): build das duas imagens (`--platform linux/arm64`), arquitetura `arm64` e usuário `node` (uid 1000), a migration pela imagem duas vezes (`node dist/migrate.js`), a API com `NODE_ENV=production` respondendo `/health/ready` 200 contra Postgres e Valkey (services), o worker em produção no ar com os emuladores do compose e o `SIGTERM` saindo com 0 nos dois. Raiz só leitura, `/tmp` gravável e init, como no ECS | main e `workflow_dispatch`; no PR, se o `changes` disser que mexe nas imagens |
| `native` (2026-11-19, Fase 4e) | Prebuild do Android na variante `production` (CNG), validação do `gradle-wrapper.jar` (`gradle/actions/wrapper-validation`), JDK 21 (Temurin, cache do Gradle pelo `setup-java`), testes de JVM do módulo NFC (`:sussurro-proximity:testDebugUnitTest`, NFC-10 a 17) e o manifesto **final** de release (`:app:processReleaseManifest`, depois do ajuste de `maxSdkVersion` do Expo), conferido pelo `scripts/check-android-manifest.mjs`. O script usa uma **lista de permitidas**, a mesma da tabela do `docs/deploy/lojas.md`: qualquer permissão fora dela falha (inclusive as que uma biblioteca nova traga pelo merge, como `AD_ID` ou `ACCESS_MEDIA_LOCATION`), assim como armazenamento legado sem `maxSdkVersion` ≤ 32 e a falta da permissão `NFC` ou do serviço HCE com `BIND_NFC_SERVICE`. A lista de permissões vai para o resumo do run, e os relatórios e o manifesto, para o artefato `android-native` (7 dias). Sem assinatura, sem bundle JS e sem segredos. O Swift continua fora (runner macOS; sai pelo EAS). Custo estimado: de 8 a 15 min por run (a confirmar no primeiro) | main e `workflow_dispatch`; no PR, se o `changes` disser que mexe na parte nativa (falha fechado: sem resposta do `changes`, roda) |
| `audit` | `pnpm audit --prod --audit-level high`, que só informa (`continue-on-error` no passo). Desde 2026-10-31 (B8), também o `scripts/audit-exceptions.mjs`, que deixa o job vermelho, inclusive no agendado, quando uma exceção do `audit.ignore` sai do caminho registrado ou passa da data de revisão (§8.3) | main (push), semanal (`schedule`) e `workflow_dispatch` |

Notas:
- **Por que gitleaks CLI e não `gitleaks-action`:** a action exige licença para contas de organização. A CLI é MIT e não tem essa dependência.
- O Secret Scanning e o Dependency Review nativos do GitHub em repositório privado exigem GitHub Advanced Security (pago). O gitleaks + Dependabot cobre o essencial sem custo.
- SQS e S3 entram no CI na Fase 2: um passo `docker compose up -d --wait elasticmq seaweedfs s3-init`, com o **mesmo compose do dev** (paridade).
- Tempo esperado: **4 a 6 min** de relógio com cache quente, 8 a 10 min frio (o `pnpm install` do RN pesa). Jobs em paralelo consomem ~12 a 15 min por execução, então os 2.000 min grátis dão ~140 execuções por mês. É suficiente para uma pessoa.
- Proteção da `main`: em repositório **privado no plano Free** não dá para exigir os checks. Opções: repositório público, GitHub Pro (US$ 4/mês) ou disciplina (PR sempre, merge só com tudo verde). Pergunta ao PO.
- (atualizado em 2026-10-31, B5) **Imagens em ARM64 nativo, sem QEMU.** Desde 2026-01-29, o `ubuntu-24.04-arm` é runner padrão também em repositório privado: 2 vCPU (4 no público), gasta a franquia do plano como o x64 e, fora dela, custa US$ 0,005/min (o x64 custa US$ 0,006). Emular ARM64 com QEMU num runner x64 multiplica o tempo do `pnpm install` e do `tsc` (mais minutos e risco de timeout), e um smoke em amd64 testaria uma arquitetura que não roda no Fargate (o Node e o `sharp` têm binário por arquitetura). Por isso não há build amd64 nem QEMU: o `images` roda tudo em ARM64.
- (atualizado em 2026-10-31) **Minutos do Actions** (repositório privado; o Free inclui 2.000/mês; cada job é cobrado em minutos inteiros, arredondados para cima). Os runs dos PRs #1 a #3 gastaram de 9 a 14 min cada: `test` de 3 a 7, `quality` de 2 a 4 e 1 em cada um dos outros. O `images` deve acrescentar de 6 a 10 min (estimativa, a confirmar no primeiro run) e o `changes`, 1 min por run de PR. Um PR que mexe nas imagens passa a gastar ~20 min por push; um só de docs, app ou testes, ~13. Quando a franquia acaba, as Actions param até o mês seguinte se a conta não tiver orçamento para elas (o padrão é US$ 0). Com orçamento, o `images` sai por ~US$ 0,05 por run. Se o consumo apertar, a alternativa mais barata é rodar o `images` só na `main` e no `workflow_dispatch` (uma linha no `if` do job), aceitando descobrir uma imagem quebrada depois do merge.

### 4.2 Fases futuras

| Fase | O que entra no CI/CD |
|---|---|
| 2 | Emuladores S3/SQS no job de teste; teste de EXIF removido com fixture. |
| 6 | Upload de sourcemaps da API e do worker para o Sentry (`sentry-cli`) e release = SHA. |
| 6/7 | `eas-build.yml` com `workflow_dispatch` (manual) e tags `v*`: `eas build --profile preview --non-interactive --no-wait` com o secret `EXPO_TOKEN`. Builds automáticos a cada PR consumiriam a cota Free. Alternativa equivalente: EAS Workflows. |
| 7 | `terraform.yml`: `fmt -check`, `validate`, `tflint` e `trivy config` (sem credenciais AWS, **sem plan nem apply**). |
| Depois do apply autorizado | `deploy.yml` na `main`: OIDC do GitHub → role de deploy (sem chaves de longa duração), build multi-arch ARM64 → ECR (tag = SHA, imutável), `ecs run-task` de migration, `ecs update-service` da API e do worker, e espera pelo `services-stable`. `terraform plan` em PR com role somente leitura. |

---

## 5. EAS (app)

### 5.1 Perfis do `eas.json` (esboço)

```json
{
  "cli": { "version": ">= 22.0.0", "appVersionSource": "remote" },
  "build": {
    "base": { "node": "26.13.0", "pnpm": "12.13.0" },
    "development": {
      "extends": "base", "developmentClient": true, "distribution": "internal",
      "environment": "development", "env": { "APP_VARIANT": "development" },
      "android": { "buildType": "apk" }
    },
    "preview": {
      "extends": "base", "distribution": "internal", "environment": "preview",
      "channel": "preview", "env": { "APP_VARIANT": "preview" },
      "android": { "buildType": "apk" }
    },
    "production": {
      "extends": "base", "environment": "production", "channel": "production",
      "autoIncrement": true, "env": { "APP_VARIANT": "production" }
    }
  },
  "submit": { "production": {} }
}
```

| Perfil | Para quê | Instalação | `EXPO_PUBLIC_API_URL` | Sentry environment |
|---|---|---|---|---|
| `development` | Dev client; o JS vem do Metro local | iPhone registrado (ad hoc) e APK Android | Do **`.env` local do `apps/mobile`** (o Metro injeta na hora do bundle): `http://<IP-LAN>:3000` | `development` |
| `preview` | Testar um build "de verdade" antes da loja | Ad hoc (iOS) / APK | `https://api.<domínio>` (produção como homologação, §2). Só existe depois do apply | `preview` |
| `production` | Loja (TestFlight → App Store, Play) | Store | `https://api.<domínio>` | `production` |

- As variáveis `EXPO_PUBLIC_*` vão **em texto claro para dentro do bundle**. Nunca segredos. Ficam nas **EAS Environment Variables** por ambiente (`development`/`preview`/`production`), com visibilidade "plain text". Já o `SENTRY_AUTH_TOKEN` (upload de sourcemaps) fica com visibilidade **secret**.
- `APP_VARIANT` no `app.config.ts` muda o bundle id e o nome. Exemplo: `app.sussurro.dev` / "Sussurro Dev" e `app.sussurro` / "Sussurro". Assim, dev e produção convivem no mesmo celular. **O bundle id definitivo é decisão do PO** e depende do domínio.

### 5.2 Credenciais iOS (sem Mac)

- **Gerenciadas pelo EAS**: no primeiro `eas build -p ios`, o EAS faz login na Apple (2FA do PO), cria certificado de distribuição, App ID e perfis de provisionamento, e guarda tudo no servidor. Nenhum `.p12` fica no PC nem no repositório.
- Dev build e preview no iPhone: registrar o aparelho uma vez com `eas device:create` (gera um link ou QR que instala um perfil no iPhone e captura o UDID). Depois disso, ligar o Modo de Desenvolvedor.
- Envio para a loja: `eas submit` com **App Store Connect API Key** (criada pelo PO e guardada no EAS).
- Android: o keystore também é gerado e guardado pelo EAS. Backup: `eas credentials` → download, guardado em um gerenciador de senhas do PO.

### 5.3 Plano gratuito do EAS (preços em 2026-10-29)

| Plano | Preço | Builds | Fila | Timeout | Update |
|---|---|---|---|---|---|
| **Free** | US$ 0 | 15 Android + 15 iOS/mês | baixa prioridade | 45 min | 1.000 MAU |
| Starter | US$ 19/mês | US$ 45 de crédito, depois por uso | alta | 2 h | 3.000 MAU |
| Production | US$ 199/mês | US$ 225 de crédito | alta | 2 h | 50.000 MAU |

Excedente: Android US$ 1 a 2 e iOS US$ 2 a 4 por build. No Free, ao fim da cota, os builds param até o dia 1º do mês seguinte.

Consumo previsto: a Fase 0 usa ~2 iOS + ~2 Android. Fases sem código nativo novo quase não consomem, porque o JS vem do Metro. **A Fase 4 (módulo nativo próprio em Swift/Kotlin: BLE na origem, NFC desde a Fase 4e, ADR 0013) pode passar de 15 builds por plataforma:** aí vale o Starter por um ou dois meses. `eas build --local` não roda no Windows. Para Android, roda dentro do WSL/Ubuntu, mas isso exige SDK e JDK no Linux e só compensa se a cota apertar.

### 5.4 Como o celular alcança a API local

| Opção | Como | Prós | Contras |
|---|---|---|---|
| **IP da LAN** (padrão) | PC e celular no mesmo Wi-Fi. `EXPO_PUBLIC_API_URL=http://192.168.x.y:3000`, API em `0.0.0.0`, firewall liberado (§1.1 #13) | Simples, rápido, grátis | HTTP em claro (veja abaixo). Não funciona em redes com isolamento de clientes (Wi-Fi de visitante, corporativa). O IP muda (fixar reserva DHCP no roteador ou usar o nome `.local`). |
| **Túnel HTTPS** (plano B) | `cloudflared tunnel --url http://localhost:3000` (quick tunnel grátis, sem conta) gera `https://<aleatório>.trycloudflare.com`. É preciso outro túnel para o S3 (8333) | HTTPS, então não há exceção de ATS nem cleartext. Funciona de qualquer rede | A URL muda a cada execução. Mais latência. Expõe a API local na internet enquanto o túnel está aberto. `expo start --tunnel` só cobre o Metro, não a API. |

Tráfego HTTP em claro, **somente no perfil `development`**, condicionado a `APP_VARIANT` no `app.config.ts`:
- **Android** (API 28 ou superior bloqueia cleartext por padrão): `expo-build-properties` com `android.usesCleartextTraffic: true` só quando `APP_VARIANT=development`.
- **iOS (ATS)**: `ios.infoPlist.NSAppTransportSecurity = { NSAllowsLocalNetworking: true }` só no development. Também é preciso `NSLocalNetworkUsageDescription` (o iOS 14 ou superior pede permissão de "Rede local"; o dev client já pede para o Metro). Se o ATS ainda bloquear por IP, usar o túnel HTTPS.
- **Preview e produção nunca têm essas exceções.** Um teste de config (snapshot do `app.config.ts` por variante) garante isso. É sugestão para o QA.

---

## 6. Infraestrutura AWS (Fase 7, só o desenho; **nunca `terraform apply`**)

> (atualizado na Fase 7) Implementado em `infra/terraform` (só código, sem `apply`), com o runbook em `docs/deploy/runbook.md` e o mapa das variáveis em `docs/deploy/variaveis.md`. O porte (§9 × §9.1) é a variável `porte` (padrão `enxuto`, P5). Diferenças deste desenho, todas registradas no README ("Fase 7: verificado × pendente"): uma execution role por task (em vez de uma só); nomes de bucket com o id da conta (unicidade global); módulos novos `ses` (D6), `access-logs` (L3, desligado) e `budgets` (no bootstrap); `prod.tfvars` fora do Git (só o `.example`); usuários do banco criados por uma task `db-bootstrap`; Performance Insights desligado por padrão; alarme de tasks pela contagem de hosts saudáveis do ALB e pela idade das filas (o `RunningTaskCount` exige Container Insights); Terraform `~> 1.16.0` e provider AWS fixado em 6.69.1.

### 6.1 Diagrama

```mermaid
flowchart TB
  APP[App] -->|HTTPS api.dominio| ALB
  APP -->|PUT pré-assinado| S3
  APP -->|GET URL assinada media.dominio| CF[CloudFront<br/>OAC + trusted key group<br/>plano flat-rate]
  CF --> S3[(S3 sussurro-prod-media<br/>incoming/ privado · media/)]
  subgraph VPC[VPC 10.20.0.0/16 · 2 AZs · sem NAT]
    subgraph PUB[subnets públicas]
      ALB[ALB :443<br/>ACM]
      API[ECS Fargate ARM<br/>api × 2<br/>IP público, SG só do ALB]
      WK[ECS Fargate ARM<br/>worker × 1<br/>sem ingress]
      MIG[task one-off<br/>migrate]
    end
    subgraph PRIV[subnets privadas isoladas · sem rota p/ internet]
      RDS[(RDS PostgreSQL 18<br/>db.t4g.small Multi-AZ)]
      VK[(ElastiCache Valkey<br/>cache.t4g.micro)]
    end
    GW[S3 gateway endpoint<br/>grátis]
  end
  ALB --> API
  API --> RDS & VK
  WK --> RDS
  MIG --> RDS
  API & WK --> SQS[[SQS media-jobs · video-events · push<br/>+ DLQs]]
  WK -->|CreateJob| MC[MediaConvert] --> S3
  MC -->|Job State Change| EB[EventBridge rule] --> SQS
  API & WK -.secrets.-> SM[Secrets Manager]
  API & WK -->|stdout JSON| CW[CloudWatch Logs + alarmes → SNS e-mail]
  WK -->|HTTPS| EXPO[Expo Push] 
  API & WK -->|HTTPS| SENTRY[Sentry]
```

### 6.2 Layout do Terraform

```
infra/terraform/
  bootstrap/            # aplicado 1x à mão (com autorização): bucket de state, OIDC do GitHub, budgets
  modules/
    network/            # VPC, 2 AZs, subnets públicas e privadas isoladas, S3 gateway endpoint, SGs base
    ecr/                # repositórios api e worker (tags imutáveis, lifecycle: manter 20)
    ecs-cluster/        # cluster + capacity providers FARGATE e FARGATE_SPOT
    ecs-service/        # genérico: task def, service, log group, autoscaling. Usado por api e worker
    alb/                # ALB, listener 443 (ACM), redirect 80→443, target group /health/ready
    rds/                # PG 18, Multi-AZ opcional, gp3, backups 14 d, PITR, deletion_protection, force_ssl
    elasticache/        # Valkey, TLS em trânsito, AUTH/RBAC, réplica opcional
    media/              # S3 (BPA, SSE-S3, versioning, lifecycle), CloudFront (OAC, key group), ACM us-east-1
    queues/             # fila + DLQ (redrive 3), SSE-SQS, long polling; políticas
    mediaconvert/       # role do MediaConvert, regra EventBridge → video-events
    secrets/            # segredos (sem valor no código; valor colocado à mão ou gerado)
    iam/                # task roles (api, worker), execution role, role de deploy GitHub OIDC
    observability/      # SNS, alarmes, dashboards mínimos, budgets, anomaly detection
    dns/                # Route 53 (zona e registros) — opcional se o domínio ficar fora da AWS
  envs/
    prod/               # main.tf (compõe os módulos), backend.tf, variables.tf, prod.tfvars (sem segredos)
    staging/            # vazio na v1 (§2)
  .tflint.hcl  versions.tf (terraform ~> 1.16, aws ~> 6.68)
```

- **State remoto:** bucket S3 `sussurro-tfstate-<conta>` com versioning, SSE e Block Public Access, e **lock nativo do S3** (`use_lockfile = true`, Terraform 1.10 ou mais recente). **Sem DynamoDB.** Uma chave por ambiente (`prod/terraform.tfstate`).
- Versões: Terraform `~> 1.16` (a 1.17 saiu em 21/10/2026, nova demais) e provider AWS `~> 6.68`. Ficam fixadas no `.terraform.lock.hcl`.
- Na Fase 7, a validação é só estática: `fmt`, `validate`, `tflint`, `trivy config`. **`plan` e `apply` exigem credenciais AWS e autorização explícita do PO.**

### 6.3 Rede: evitar o NAT Gateway

| Opção | Custo/mês (sa-east-1) | Avaliação |
|---|---|---|
| Subnets privadas + NAT Gateway (1 por AZ) | US$ 0,093/h × 730 = **~US$ 68 por NAT** (US$ 136 com 2 AZs) + US$ 0,093/GB processado | É o padrão "de livro", mas em sa-east-1 custa mais que o banco. |
| Subnets privadas + VPC interface endpoints | US$ 0,021/h por endpoint por AZ = ~US$ 15,30. Seriam precisos ECR api, ECR dkr, Logs, SQS, Secrets Manager e MediaConvert: 6 × 2 AZs = **~US$ 184** | Mais caro ainda. **E não resolve**: o worker precisa de Expo Push e a API e o worker precisam do Sentry na internet, ou seja, NAT de qualquer jeito. |
| **Fargate em subnets públicas com IP público + security groups** (recomendado) | US$ 0,005/h por IPv4 = **US$ 3,65 por task** | A API aceita entrada **só do SG do ALB** (porta 3000). O worker não aceita entrada. A saída é 443. RDS e Valkey ficam em subnets **privadas sem rota para a internet**, acessíveis só pelos SGs das tasks. O S3 gateway endpoint é grátis. |
| NAT em instância (fck-nat, t4g.nano) | ~US$ 4 a 6 | Alternativa se um dia quisermos tasks sem IP público. É mais uma peça para operar. Fora da v1. |

### 6.4 Componentes

| Componente | Definição |
|---|---|
| **ECS API** | Fargate **ARM64 (Graviton, ~20% mais barato)**, 0,5 vCPU/1 GB, `desired = 2` em 2 AZs, autoscaling por CPU (alvo 60%, máximo 4). `stopTimeout` de 30 s com shutdown gracioso. |
| **ECS worker** | 0,5 vCPU/1 GB, `desired = 1`. (corrigido em 2026-10-31) Os jobs agendados não usam lock no Redis: cada réplica roda o seu `setInterval`, e as linhas com efeito colateral (contas a apagar, rascunhos, posts apagados, uploads de avatar e recibos do push) são reservadas com `FOR UPDATE SKIP LOCKED` no Postgres; o resto são `DELETE` por prazo, que podem repetir sem efeito (arquitetura §5; `apps/worker/src/jobs`). Pode rodar em **FARGATE_SPOT** (economia de ~70%): uma interrupção só devolve as mensagens à fila. Shutdown gracioso no SIGTERM (2 min de aviso no Spot). |
| **Imagens** | Multi-stage `node:26-slim` (ADR 0001), usuário não-root, `pnpm deploy --prod` por app, `sharp` nativo ARM64. Build ARM64 no CI: (atualizado em 2026-10-31, B5) runner `ubuntu-24.04-arm`, nativo e sem QEMU, no job `images` (§4.1). O push para o ECR fica para o `deploy.yml`, depois do apply autorizado (§4.2). |
| **RDS** | PostgreSQL 18, `db.t4g.small` **Multi-AZ**, gp3 20 GB com autoscaling de storage até 100 GB, criptografado, `rds.force_ssl=1`, backups de 14 dias + PITR, `deletion_protection`, Performance Insights (7 dias grátis), senha mestre **gerenciada pelo RDS no Secrets Manager** (`manage_master_user_password`). Um usuário de aplicação sem privilégio de DDL; as migrations usam um usuário próprio. |
| **ElastiCache** | Valkey 8.x, `cache.t4g.micro`, nó único na v1 (arquitetura §1), TLS em trânsito e AUTH. Réplica no cenário de crescimento. |
| **S3** | Bucket `sussurro-prod-media`: Block Public Access, SSE-S3, **versioning com expiração de versões antigas em 7 dias** (protege contra deleção acidental e ainda cumpre a promessa de exclusão), lifecycle `incoming/` com 1 dia, abortar multipart incompleto em 1 dia. |
| **CloudFront** | Origem S3 com **OAC** (só `media/*`), **trusted key group** (chave pública no Terraform; a privada no Secrets Manager, usada pela API para assinar URLs de 6 h). Cache policy **sem query string na chave** (a assinatura não fragmenta o cache). `media.<domínio>` com ACM em us-east-1. **Plano flat-rate** (§9.2): a documentação da AWS confirma suporte a OAC e URLs assinadas em todos os planos. |
| **SQS** | `media-jobs` (visibility 120 s), `video-events` (60 s) e `push` (60 s), cada uma com DLQ (`maxReceiveCount = 3`, retenção de 14 dias), SSE-SQS e long polling de 20 s. |
| **EventBridge** | Regra `source = aws.mediaconvert`, `detail-type = "MediaConvert Job State Change"`, `status ∈ {COMPLETE, ERROR}` e `userMetadata.app = sussurro` → SQS `video-events` (a política da fila permite só essa regra). |
| **MediaConvert** | Role de serviço com leitura em `incoming/*` e escrita em `media/*`. Tier Basic, AVC 720p: **US$ 0,0094/min** em sa-east-1 (lista de preços da AWS). |
| **Secrets Manager** | `jwt-access`, `cloudfront-private-key`, `expo-access-token`, `sentry-dsn` (opcional; não é segredo) e a senha do RDS (gerenciada). Injetados via `secrets` da task definition (`valueFrom`). Configuração não secreta fica em variáveis da task ou no SSM Parameter Store Standard (grátis). |
| **ALB** | TLS 1.2 ou superior (política `ELBSecurityPolicy-TLS13-1-2-2021-06`), health check em `/health/ready`, `deregistration_delay` de 30 s. WAF fica fora da v1; o rate limit está na aplicação. |

### 6.5 IAM com menor privilégio

| Role | Permissões |
|---|---|
| Execution role (ECS) | `ecr:GetAuthorizationToken`, pull dos 2 repositórios, `logs:CreateLogStream/PutLogEvents` nos log groups do app, `secretsmanager:GetSecretValue` **só nos ARNs listados**. |
| Task role API | `s3:PutObject` em `incoming/*` (para presign), `s3:GetObject`/`HeadObject` em `incoming/*` e `media/*`, `s3:DeleteObject` em `media/*` (exclusão de post/conta), `sqs:SendMessage` nas 3 filas. |
| Task role worker | `sqs:ReceiveMessage/DeleteMessage/ChangeMessageVisibility` nas 3 filas, `s3:GetObject/DeleteObject` em `incoming/*`, `s3:PutObject/DeleteObject` em `media/*`, `mediaconvert:CreateJob/GetJob`, `iam:PassRole` **só para a role do MediaConvert**. |
| Role do MediaConvert | `s3:GetObject` em `incoming/*` e `s3:PutObject` em `media/*`. |
| Deploy (GitHub OIDC) | Trust só em `repo:<org>/sussurro:ref:refs/heads/main`. ECR push nos 2 repositórios, `ecs:RegisterTaskDefinition/UpdateService/RunTask/DescribeServices`, `iam:PassRole` só nas roles de task. **Nenhuma chave de acesso de longa duração.** |
| Plan (futuro) | `ReadOnlyAccess` + leitura do bucket de state, trust só em PRs. |

Conta AWS: usuário root com MFA e sem chaves. Acesso humano via IAM Identity Center (grátis). CloudTrail com uma trilha de gerenciamento (grátis).

### 6.6 Estratégia de deploy

1. CI verde na `main` → build da imagem (tag = SHA do git, ECR com **tags imutáveis**).
2. **Migrations como task separada**: `aws ecs run-task` com a mesma imagem e o comando `node dist/migrate.js` (drizzle-kit migrate). O pipeline espera o exit code 0. Se falhar, o deploy para e nada muda.
3. **Regra expand/contract**: toda migration precisa ser compatível com a versão anterior do código (adicionar coluna nullable → deploy → backfill → tornar obrigatória numa release seguinte). Assim, o rolling e o rollback nunca quebram.
4. **Rolling update** da API (`minimumHealthyPercent = 100`, `maximumPercent = 200`) com **deployment circuit breaker + rollback automático**. Depois, o worker.
5. **Rollback**: redeploy da task definition anterior (`aws ecs update-service --task-definition api:<rev-anterior>`), em menos de 5 min. Migrations não são revertidas automaticamente (expand/contract torna isso desnecessário). Em caso extremo, PITR do RDS.
6. Blue/green ou canary: fora da v1. O ECS suporta blue/green nativo se for preciso no futuro.

---

## 7. Observabilidade

| Peça | Definição |
|---|---|
| **Sentry: projetos** | `sussurro-mobile` (React Native), `sussurro-api` (NestJS) e `sussurro-worker` (Node). |
| Environments | `local` (desligado: sem DSN), `development`, `preview` e `production`. O valor vem de `SENTRY_ENVIRONMENT` (servidor) e do perfil EAS (app). |
| Releases | App: `app.sussurro@<versão>+<buildNumber>` (padrão do SDK RN), com `dist` = build number. API/worker: `sussurro-api@<sha>`. |
| Sourcemaps do app | Plugin `@sentry/react-native/expo` + `getSentryExpoConfig` no Metro. **O EAS Build faz o upload sozinho** quando há `SENTRY_AUTH_TOKEN` (secret no EAS). Para EAS Update: `npx sentry-expo-upload-sourcemaps dist` depois do `eas update`. |
| Privacidade | `sendDefaultPii: false`, `beforeSend` removendo `Authorization`, `password`, `token`, `observedToken` e `targetToken` (arquitetura §15). `tracesSampleRate` 0,05 a 0,1 para caber no plano. |
| **Logs** | `pino` (via `nestjs-pino`) em JSON no stdout → driver `awslogs` → CloudWatch Logs. Um log group por serviço, **retenção de 30 dias**. Campos: `time`, `level`, `msg`, `reqId`, `traceId`, `userId` (uuid), `route`, `status`, `durationMs`. `redact` de headers e campos sensíveis. **Sem corpo de requisição.** O `/health` não gera log. |
| Classe de log | Ingestão em sa-east-1: **US$ 0,90/GB (Standard)** e US$ 0,45/GB (Infrequent Access). Começar com Standard (Live Tail e metric filters) e avaliar IA quando o volume crescer. |
| **Métricas e alarmes** (SNS → e-mail do PO) | ALB: 5xx > 1% em 5 min, `TargetResponseTime` p95 > 1 s, `UnHealthyHostCount` > 0. ECS: `RunningTaskCount` < desired, CPU ou memória > 85%. RDS: CPU > 80%, `FreeStorageSpace` < 20%, `FreeableMemory` baixa, conexões > 80% do máximo. Valkey: memória > 80%, evictions > 0. **SQS: qualquer DLQ com mensagens > 0**, `ApproximateAgeOfOldestMessage` > 5 min em `media-jobs`. MediaConvert: job com ERROR (vem do próprio fluxo, com métrica customizada do worker). Total de ~15 alarmes (US$ 0,10 cada; os 10 primeiros são grátis). |
| Saúde externa | `/health` monitorado de fora por um serviço de uptime gratuito (ex.: UptimeRobot ou Better Stack free) ou Route 53 health check. A AWS não percebe se o DNS ou o certificado quebrar. |
| **Custo** | **AWS Budgets** (2 orçamentos grátis): mensal com alertas a 50%, 80% e 100% (real) e 100% (previsto), mais um orçamento só para o MediaConvert e o CloudFront (abuso de vídeo, R10). **Cost Anomaly Detection** ligado (grátis). |
| **OpenTelemetry (preparado, desligado)** | Na v1: só `@opentelemetry/api` nos pontos de borda (interceptor HTTP, consumidores SQS, `VideoProcessor`, chamadas ao Expo). O `traceparent` é propagado nos *message attributes* do SQS, e o `traceId` vai para o log. Sem SDK nem collector (`OTEL_ENABLED=false`). O SDK do Sentry 8 ou mais recente já é baseado em OTel, então os spans aparecem no Sentry. Depois: sidecar ADOT/collector exportando OTLP. |

---

## 8. Segurança

| Tema | Definição |
|---|---|
| Segredos locais | `.env` no `.gitignore`. Só `.env.example` é versionado. O script de setup gera `JWT_ACCESS_SECRET` localmente. |
| Segredos em produção | Secrets Manager + IAM por ARN (§6.4/§6.5). Nada de segredo em `tfvars`, task definition em texto, `eas.json` ou `EXPO_PUBLIC_*`. |
| Segredos no CI | Na Fase 0, nenhum. Depois: `EXPO_TOKEN` e `SENTRY_AUTH_TOKEN` como secrets do GitHub, e AWS **somente via OIDC**. |
| **gitleaks** | No CI em todo PR e push, com histórico completo (§4.1). Opcional: hook local de pre-commit (`gitleaks git --staged`) se o Dev adotar lefthook/husky. `.gitleaks.toml` com allowlist só para os valores fictícios do `.env.example` (`local`, `sussurro`). Falso positivo: §8.1. Donos dos arquivos de exceção: §8.2. |
| **Dependências** | **Dependabot** (nativo e grátis em repositório privado) com os ecossistemas `npm` (pnpm), `github-actions`, `docker-compose`, `docker` (Fase 7) e `terraform` (Fase 7). Atualizações semanais, **agrupadas** (dev-deps, `@nestjs/*`, `@sentry/*`). **Ignorar majors do `expo`, `react-native` e `react`**: o upgrade de SDK é manual com `expo install --fix`. Atualizações de segurança: imediatas. Renovate fica como alternativa se o Dependabot gerar ruído demais (agrupa melhor no monorepo, mas exige instalar um app). |
| Cadeia de suprimentos | `--frozen-lockfile`, `minimumReleaseAge` e `onlyBuiltDependencies` no pnpm (§1.2), actions fixadas por SHA, imagens fixadas por tag (digest na Fase 7), `permissions: contents: read` no CI, `pnpm audit` semanal (exceções: §8.3). |
| Rede | §6.3: banco e cache sem rota para a internet, SG por origem, TLS no ALB e no CloudFront, `force_ssl` no RDS, TLS no Valkey. |
| **Backups** | RDS: automáticos de 14 dias + PITR (5 min de RPO). **Snapshot manual antes de toda migration destrutiva.** S3: versioning com 7 dias de versões antigas. State do Terraform: versioning. Credenciais do app: guardadas no EAS + backup do keystore Android com o PO. |
| **Restore** | Runbook na Fase 7: (1) PITR para uma nova instância `sussurro-restore-<data>`, (2) smoke test com a task de migration em modo `--check`, (3) troca do endpoint via Secrets Manager e redeploy, (4) remoção da instância antiga. **Exercício de restore a cada trimestre**, cronometrado (meta: RTO < 1 h), sempre com autorização do PO porque cria recurso pago por algumas horas. |
| LGPD | Os backups expiram em 14 dias e as versões S3 antigas em 7, o que precisa constar na política de privacidade (arquitetura §15). Dados ficam em sa-east-1. |

### 8.1 Falso positivo do gitleaks: passo a passo

(atualizado em 2026-10-31, B7) O job `secrets` lê **todo o histórico** do PR. Tirar o valor do arquivo não basta, porque o commit que o trouxe continua no histórico do branch. O caminho padrão é o do PR #3:

1. **Leia o achado no log do `secrets`.** Com `--redact`, o gitleaks mostra a regra (`RuleID`), o arquivo, a linha, o commit e a impressão digital (`Fingerprint`, no formato `commit:arquivo:regra:linha`), sem o valor. No PR #3: regra `generic-api-key`, linha 1513 de `apps/mobile/src/features/connect/useTouch.test.tsx`, commit 8b86e22, com o token fictício do teste PROX-70.
2. **Decida se é segredo.** Na dúvida, é: revogue ou rotacione primeiro e só depois decida com o PO entre reescrever o histórico e registrar a exceção (cabeçalho do `.gitleaks.toml`). Um valor que já funcionou em algum lugar nunca é falso positivo.
3. **Tire o literal do arquivo** num commit novo do mesmo PR, de um jeito que não case mais com a regra. Quem muda é o dono da pasta. No PR #3, o `testes` passou o valor para uma constante no topo do arquivo (commit 1d6ec15).
4. **Registre a impressão digital do commit antigo** no `.gitleaksignore`: uma linha por achado, copiada do log, com um comentário (o commit, o caso de teste e por que o valor é fictício). Quem edita é o `devops`. Só a impressão digital exata: nada de ampliar o allowlist do `.gitleaks.toml` por caminho ou por regra, nem `gitleaks:allow` novo, que fica no código, fora do `CODEOWNERS` (§8.2).
5. **Revisão do `seguranca`**, obrigatória. Ele confere que o valor é fictício, que o literal saiu do arquivo e que a linha nova cobre só aquele achado. No PR #3, aprovou sem achados e preferiu este caminho a reescrever o histórico, que exigiria force push e a confirmação do PO.
6. **`secrets` verde** e o registro no PR e no README: o que era, o commit e quem aprovou.

Com o squash merge, o commit antigo não chega à `main`. A linha do `.gitleaksignore` serve ao CI do PR e fica como registro.

### 8.2 Donos dos arquivos de exceção (`CODEOWNERS`)

(atualizado em 2026-10-31, B7) O `.github/CODEOWNERS` põe o PO (`@Pedro-viniicius`) como dono de:
- `.gitleaksignore`, `.gitleaks.toml` e `.github/` (CI, Dependabot e o próprio `CODEOWNERS`);
- `pnpm-workspace.yaml`, `scripts/audit-exceptions.mjs` e `.npmrc`: as exceções do audit (§8.3) e a configuração do pnpm;
- `CLAUDE.md` e `.claude/`: as instruções e as permissões dos agentes;
- `apps/*/Dockerfile`, `.dockerignore` e `infra/terraform/`: o que vai para produção.

Sem isso, qualquer PR pode acrescentar uma impressão digital ou uma GHSA, e só a revisão do `seguranca` segura.

O arquivo só tem efeito com as duas condições abaixo, e as duas são decisão do PO (§10, P2; `PROJETO.md`, D16; `testes.md`, A-42):
- **Plano:** em repositório privado, o GitHub só usa o `CODEOWNERS` com o GitHub Pro (US$ 4/mês) ou o Team. No Free, nem o pedido automático de revisão acontece.
- **Proteção da `main`**, com "Require a pull request before merging" e "Require review from Code Owners" (ou a regra equivalente num ruleset).

Com uma conta só, há um efeito colateral: o GitHub não deixa o autor aprovar o próprio PR. Com o PO como único dono e os PRs abertos pela conta dele, a regra trava os PRs que mexem nesses caminhos, e o merge só sai com o bypass de administrador. Ela vale de verdade nos PRs de outros autores (o Dependabot, uma segunda pessoa). Recomendação: ligar junto com a proteção da `main`, quando houver uma segunda pessoa na equipe (a mesma recomendação da P2). Até lá, quem segura é a revisão do `seguranca` em todo diff.

### 8.3 Exceções do `pnpm audit`

(atualizado em 2026-10-31, B8) Uma exceção só entra quando não há versão corrigida que se possa usar e o caminho vulnerável não chega à API, ao worker nem ao app em produção. Ela tem três partes, mudadas juntas e com o aval do `seguranca`:
- a GHSA no `audit.ignore` do `pnpm-workspace.yaml` (pnpm 12; o `auditConfig.ignoreGhsas` antigo ainda é lido, mas está obsoleto);
- o registro em `scripts/audit-exceptions.mjs`: o pacote, a primeira versão corrigida, os únicos pacotes que podem trazer a versão vulnerável e a data de revisão;
- a linha na tabela abaixo.

O pnpm ignora a GHSA inteira, em qualquer caminho e sem prazo. Por isso o script roda no job `quality`, em todo PR e bloqueando o merge, e no job `audit` (push na `main`, agendado e manual), onde deixa o job vermelho. Ele falha fechado quando:
- qualquer GHSA aparece no `pnpm-workspace.yaml`, no `package.json` ou no `.npmrc`, em qualquer lugar e grafia (comentário, aspas, estilo fluxo, o `auditConfig` antigo), sem registro no script;
- a versão vulnerável chega por outro pacote, ou sem pacote conhecido. Pré-versão da versão corrigida (`4.6.6-beta.1`) e versão não numérica (`link:`, `file:`, git) contam como vulneráveis;
- a data de revisão passa. Depois dela, todo PR fica vermelho até alguém revisar a exceção;
- não sobra versão vulnerável (a exceção precisa sair);
- um registro não tem a GHSA no `pnpm-workspace.yaml`.

A conferência contra o próprio `pnpm audit --json` ficou de fora: no pnpm 12.13, o JSON só tira a GHSA ignorada de `advisories` (o `metadata` ainda a conta), não lista as ignoradas e depende da rede.

| GHSA | Pacote e caminho | Por que a exceção | Saída | Revisar até |
|---|---|---|---|---|
| GHSA-mrhx-c7xc-m3w5 (CVE-2023-54404; alta, CVSS 4.0 8,2, só disponibilidade) | `zod` 3.25.76, só pelo `@expo/cli` 58.1.17 (`expo` 58.0.21), em 42 caminhos, todos do `apps/mobile` | Afeta todo `zod` anterior ao 4.6.6: a validação de um array sem limite de tamanho acumula um erro por elemento e pode estourar a memória. Não há 3.x corrigido (a última é a 3.25.76, de 2025-07-08), e um override para o 4.x quebraria o `@expo/cli`, que usa a API do zod 3. O `@expo/cli` é a CLI de desenvolvimento do Expo (`expo start`, `export`, `prebuild`): roda na máquina de dev e no EAS Build, com a configuração do próprio projeto, e não entra no bundle do app nem nas imagens. Nossos pacotes usam o `zod` 4.6.7 | O `@expo/cli` 58.1.18, publicado em 2026-10-31 com o `expo` 58.0.22, não depende mais do zod. Com o cooldown de 14 dias, o grupo `expo` do Dependabot deve propor a atualização a partir de 2026-11-14. Depois do merge, tire a GHSA do `audit.ignore` e o registro do script (o próprio script avisa) | 2026-11-30 |

(atualizado em 2026-11-19) **A exceção acima saiu.** O `expo` 58.0.26 traz o `@expo/cli` 58.1.21, e o lockfile não tem mais `zod` anterior ao 4.6.6 (só o 4.6.7). O próprio `scripts/audit-exceptions.mjs` passou a falhar pedindo a remoção, como previsto. O `audit.ignore` e a lista `EXCEPTIONS` ficaram vazios.

Os outros avisos do `pnpm audit --prod` em 2026-10-31 estão abaixo do nível `high` do CI e não falham o job:

| GHSA | Severidade | Pacote | Corrigido em | De onde vem |
|---|---|---|---|---|
| GHSA-gcqx-w48m-w2h4 (prototype poisoning no `mergeObject()`) | baixa | `deepmerge` 4.3.1 | sem correção | `@expo/config` (por `expo`, `@expo/cli`, `@expo/metro-config` e `@expo/prebuild-config`), só no `apps/mobile` |
| GHSA-g3hv-75wg-m249 (DoS por amplificação de "globparts") | moderada | `minimatch` 10.2.6 | 11.0.1 | o `glob` 13.0.6 dos pacotes `@expo/*` no app; o `eslint` do `packages/config`; e, na API e no worker, `@sentry/nestjs` → `@sentry/node` → `@sentry/bundler-plugins` → `glob` |
| GHSA-3g3m-2fjr-6pw4 (cancelamento por `AbortSignal` ignorado) | moderada | `glob` 13.0.6 | 14.0.2 | os mesmos caminhos do `minimatch`, menos o `eslint` |

(atualizado em 2026-11-19) Hoje o `pnpm audit --prod` só mostra os dois moderados abaixo (`minimatch` e `glob`). O GitHub retirou ("Withdrawn") o aviso do `deepmerge`. As quatro GHSAs do `node-forge` ≤ 1.4.2, publicadas em 2026-11-10 (três moderadas e uma baixa; só pela CLI do Expo e pelo `@expo/code-signing-certificates`, fora do app e das imagens), saíram com o `node-forge` 1.4.3 no PR #13.

Os dois moderados entram nas imagens pelo SDK do Sentry. O `@sentry/node` só usa o `@sentry/bundler-plugins` nas entradas `bundler-plugin/*` (plugins de esbuild, rollup e vite), que a API e o worker não importam. A correção vem do Sentry, e o grupo `sentry` do Dependabot a traz quando sair.

---

## 9. Estimativa de custo mensal (sa-east-1, USD, 730 h/mês)

Preços da **AWS Price List API (sa-east-1), consultada em 2026-10-29**. Não incluem impostos (no Brasil incidem tributos sobre serviços digitais: some ~15 a 20% à fatura). Free Tier de 12 meses não considerado.

Premissas de uso:
- **Lançamento** (dimensionamento do arquiteto): ~1 mil usuários ativos/dia, ~1,5 TB/mês de mídia servida, ~5 milhões de requisições ao CDN, 1 mil reels/mês com ~30 s cada.
- **Crescimento (10×)**: ~10 mil ativos/dia, ~15 TB/mês, ~35 milhões de requisições ao CDN, 10 mil reels/mês.

| Serviço | Preço unitário (sa-east-1) | Lançamento | Crescimento (10×) |
|---|---|---|---|
| Fargate API (ARM) | vCPU US$ 0,0557/h, GB US$ 0,00612/h | 2 × (0,5 vCPU/1 GB) = **49,60** | 3 × (1 vCPU/2 GB) = **148,80** |
| Fargate worker (ARM) | idem | 1 × (0,5/1) = **24,80** | 2 × (0,5/1) = **49,60** |
| IPv4 públicos (tasks + ALB) | US$ 0,005/h (US$ 3,65 cada) | 5 IPs = **18,25** | 7 IPs = **25,55** |
| ALB | US$ 0,034/h + US$ 0,011/LCU-h | 24,82 + ~1 LCU = **33** | 24,82 + ~5 LCU = **65** |
| RDS PostgreSQL | t4g.small Multi-AZ US$ 0,137/h; t4g.medium Multi-AZ US$ 0,275/h; gp3 Multi-AZ US$ 0,438/GB | small + 20 GB = **109** | medium + 100 GB = **245** |
| ElastiCache Valkey | t4g.micro US$ 0,024/h; t4g.small US$ 0,0488/h | 1 × micro = **17,50** | 2 × small (primário + réplica) = **71,25** |
| S3 | US$ 0,0405/GB; PUT US$ 0,007/mil; GET US$ 0,0056/10 mil | 50 GB + requisições = **3** | 1 TB + requisições = **47** |
| CloudFront | Pay-as-you-go América do Sul: US$ 0,110/GB (1 TB grátis/mês). **Flat-rate**: Pro US$ 15 (10 milhões de req., 50 TB), Business US$ 200 (125 milhões de req., 50 TB) | Pro = **15** (PAYG daria ~56) | Business = **200** (PAYG daria **~US$ 1.650**) |
| MediaConvert | Basic, AVC HD: US$ 0,0094/min de saída | 500 min = **5** | 5 mil min = **47** |
| SQS | US$ 0,40/milhão (1 milhão grátis/mês) | **0** | ~3 milhões = **1** |
| Secrets Manager | US$ 0,40/segredo | 5 = **2** | **2** |
| CloudWatch (logs + alarmes) | Ingestão US$ 0,90/GB, armazenamento US$ 0,0408/GB, alarme US$ 0,10 | ~5 GB + 15 alarmes = **6** | ~40 GB = **40** |
| Saída de dados da API (JSON) | ~US$ 0,15/GB, 100 GB/mês grátis | **0** | ~300 GB = **30** |
| ECR, Route 53, EventBridge, KMS, CloudTrail | ECR US$ 0,10/GB; zona DNS incluída no plano flat-rate do CloudFront | **1** | **2** |
| **Total AWS** | | **~US$ 285/mês** | **~US$ 975/mês** |

### 9.1 Versão enxuta para baratear o lançamento (~US$ 155/mês)

| Corte | Economia/mês | O que se perde |
|---|---|---|
| RDS `db.t4g.micro` **Single-AZ** (US$ 0,034/h + gp3 US$ 0,219/GB) | ~US$ 80 | Failover automático. A meta de 99,5% fica em risco em manutenção ou falha de AZ (RPO de 5 min continua com PITR). Pode subir para Multi-AZ depois, sem downtime relevante. |
| API com **1 task** (autoscaling 1 → 3) | ~US$ 28 | Redundância entre AZs. O rolling deploy continua sem downtime (sobe a nova antes de derrubar a velha). |
| Worker em **FARGATE_SPOT** | ~US$ 17 | Nada relevante: interrupções devolvem as mensagens à fila. |
| Segredos no **SSM Parameter Store** (SecureString, grátis) | ~US$ 2 | Rotação automática nativa. |
| Logs em classe **Infrequent Access** | ~US$ 2 a 3 | Live Tail e metric filters. |
| **Não cortar**: CloudFront flat-rate, budgets, backups do RDS e o ALB | | |

Outros cortes possíveis, não recomendados: tirar o ElastiCache (o Redis é central para proximidade e rate limit) ou servir mídia sem CloudFront (perde URL assinada e cache).

**Maior risco de custo: a entrega de vídeo pelo CDN.** No modelo pay-as-you-go, 15 TB/mês custariam ~US$ 1.650. O plano flat-rate Business (US$ 200) resolve até 50 TB e 125 milhões de requisições. Acima disso, a AWS "ajusta a entrega" (menos edges), mas não cobra excedente. Também por isso valem os limites de reel (D10: 90 s / 200 MB) e o MP4 de 720p.

### 9.2 Custos fixos fora da AWS

| Item | Fase 0 | Lançamento | Observação |
|---|---|---|---|
| Apple Developer | US$ 99/ano (~8,25/mês) | idem | Necessário já na Fase 0 para "roda no iOS". |
| Google Play | — | US$ 25, pagamento único | + teste fechado de 14 dias (§1.5). |
| EAS | US$ 0 (Free) | US$ 19/mês (Starter: fila prioritária, 3 mil MAU no Update) | Free pode bastar se a fila lenta for tolerável. |
| Sentry | US$ 0 (Developer) | US$ 26/mês (Team, anual) | O Free (5 mil erros, 1 usuário) estoura rápido com usuários reais. |
| GitHub | US$ 0 | US$ 0 a 4/mês | US$ 4 se o PO quiser branch protection e `CODEOWNERS` em repositório privado (Pro). Actions: 2.000 min/mês no Free; o job `images` (ARM64) soma de 6 a 10 min por run que mexe nas imagens (§4.1). |
| Domínio | — | R$ 40/ano (.com.br) ou ~US$ 15 a 20/ano (.app) | |
| Docker Desktop | US$ 0 | US$ 0 | Dentro do limite de uso gratuito. |
| LocalStack (só se o PO escolher a opção A) | US$ 39 a 45/mês | idem | Por desenvolvedor. |
| Expo Push | US$ 0 | US$ 0 | |
| **Total fora da AWS** | **~US$ 8/mês** (Apple) | **~US$ 53/mês** | |

**Até o fim da Fase 7, o gasto com AWS é US$ 0:** tudo roda local e no CI, e o Terraform não é aplicado. O primeiro custo da AWS só aparece com o apply autorizado pelo PO.

---

## 10. Riscos e decisões para o PO

### Riscos

| # | Risco | Mitigação |
|---|---|---|
| I1 | **7,7 GB de RAM** na máquina de dev (Docker + Metro + VS Code + navegador) | `.wslconfig` com 3 GB. Emuladores leves (opção B). Sem emulador Android. |
| I2 | Imagem do EAS ainda não suportar o Node 26 | Smoke test da Fase 0. Fallback para o Node 24 (ADR 0001). |
| I3 | Emuladores (ElasticMQ/SeaweedFS) divergirem da AWS em presign ou headers | Spike da Fase 0 com os mesmos testes. Plano B: LocalStack Base. Teste de fumaça contra a AWS real só depois do apply. |
| I4 | Cota Free do EAS estourar na Fase 4 (módulo nativo de proximidade: NFC desde a Fase 4e) | Starter (US$ 19) por 1 ou 2 meses, ou build local Android no WSL. |
| I5 | Celular sem acesso à API local (isolamento de rede, IP mudando, ATS) | Reserva DHCP, regras de firewall e túnel HTTPS como plano B. |
| I6 | Custo do CDN com vídeo | Plano flat-rate, limites de reel, budget específico. |
| I7 | Repositório privado no GitHub Free sem branch protection | Pro (US$ 4) ou repositório público. Veja a pergunta P2. |
| I8 | Fargate com IP público (superfície maior que em subnet privada) | SG sem entrada além do ALB; worker sem ingress; banco e cache isolados. Revisar no apply. |

### Perguntas ao PO

| # | Pergunta | Recomendação |
|---|---|---|
| **D2** | LocalStack (pago para uso comercial, US$ 39 a 45/mês por dev, token) **ou** ElasticMQ + SeaweedFS (grátis)? | ElasticMQ + SeaweedFS |
| **D16 / P1** | Confirma **GitHub + GitHub Actions**? Repositório **privado**? Conta pessoal ou organização? | Sim; privado; conta pessoal |
| P2 | Em repositório privado: pagar GitHub Pro (US$ 4/mês) para checks obrigatórios na `main`, ou seguir com disciplina? | Começar sem pagar e reavaliar quando houver uma segunda pessoa |
| P3 | Tem **aparelho Android** físico? A Fase 4 exige iPhone + Android | Sim, com dev build pelo EAS e sem Android Studio |
| P4 | Ambientes: aceita **local + produção** (sem staging na v1)? | Sim |
| P5 | Lançamento: dimensionamento do arquiteto (~US$ 285/mês) ou **versão enxuta (~US$ 155/mês)** aceitando Single-AZ no banco? | Enxuta até ter usuários pagantes ou com SLA; o Terraform permite subir com uma variável |
| P6 | **Domínio** e **bundle id** (ex.: `sussurro.app` / `app.sussurro`)? Apple como **pessoa física ou jurídica**? | Definir antes do primeiro build iOS (o bundle id é difícil de trocar depois) |
| P7 | Orçamento mensal para o **budget alarm** da AWS? | US$ 200 (enxuta) ou US$ 350 (arquiteto) |
| D4 | Sentry na Fase 0 com SDK desligado sem DSN? | Sim (a conta pode esperar a Fase 6) |

---

## Fontes (consultadas em 2026-10-29)

- LocalStack, preços e plano Hobby não comercial: https://localstack.cloud/pricing · licenciamento e auth token: https://docs.localstack.cloud/aws/licensing/ · uso justo: https://localstack.cloud/legal/fair-usage · anúncio da mudança de 2026: https://blog.localstack.cloud/2026-upcoming-pricing-changes/
- Expo/EAS, planos e limites: https://expo.dev/pricing.md · https://docs.expo.dev/billing/plans/
- AWS Price List API (sa-east-1, arquivos `index.csv` de AmazonECS, AmazonRDS, AmazonElastiCache, AWSELB, AmazonS3, AmazonVPC, AWSQueueService, AWSSecretsManager, AmazonCloudWatch, AWSElementalMediaConvert e AmazonCloudFront): https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/
- NAT Gateway sa-east-1 (US$ 0,093/h e /GB; confirmar na página oficial): https://aws.amazon.com/vpc/pricing/ · https://cost-website.pages.dev/blog/aws-nat-gateway-regional-pricing
- CloudFront flat-rate (planos, franquias, OAC e URLs assinadas suportados, sem excedente): https://docs.aws.amazon.com/PricingPlanManager/latest/UserGuide/plans.html · https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html · https://aws.amazon.com/about-aws/whats-new/2025/11/aws-flat-rate-pricing-plans
- Sentry, planos: https://sentry.io/pricing/ · https://last9.io/blog/sentry-pricing/
- Versões: registry npm (pnpm 12.13.0 em 13/10/2026, mais recente 12.16.1; turbo 2.11.x; eas-cli 22.x), Docker Hub (postgres 18.6, valkey 8.1, elasticmq-native 1.7.1, localstack 2026.10.x, aws-cli 2.38.5, gitleaks v8.30.1), GitHub Releases (SeaweedFS 4.48 em 28/09/2026; actions/checkout v7, setup-node v7, cache v6, pnpm/action-setup v6; Terraform 1.16/1.17; provider AWS 6.68 a 6.71).
