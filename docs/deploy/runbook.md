# Runbook da produção: primeiro deploy, deploy, rollback e segredos

> Fase 7 (backlog 7.7). Autor: DevOps, 2026-10-30. Código: `infra/terraform` (layout no README de lá), Dockerfiles em `apps/api` e `apps/worker`, variáveis em [`variaveis.md`](variaveis.md), lojas em [`lojas.md`](lojas.md).
> **Nada aqui foi executado.** Todo `terraform apply` e toda ação que cria recurso pago exige **autorização explícita do PO**, registrada antes de começar. Sem ela, pare no `plan`.

## Como usar

- Os comandos são para o **Git Bash** (já instalado com o Git), na raiz do repositório, salvo indicação. Cada passo diz o que conferir antes de seguir: não pule a conferência.
- Valores reais (conta, domínio, e-mails, chaves) ficam **fora do Git**: `prod.tfvars`, `backend.hcl` e `bootstrap.tfvars` estão no `.gitignore`. Guarde uma cópia deles no gerenciador de senhas do PO.
- Nomes: o prefixo é `sussurro-prod` (variáveis `project` e `environment`). Onde aparecer `<conta>`, use os 12 dígitos da conta da AWS; `<domínio>`, o domínio do P6.
- Um passo deu errado? Pare, anote a saída e não tente "consertar" com `terraform state`, `import` ou `destroy` sem o DevOps.

Atalho usado em vários passos (cole uma vez por terminal, dentro de `infra/terraform/envs/prod`):

```bash
# Lê um campo de uma saída do Terraform que é um mapa (o PC não tem jq): tf_map task_definition_arns api
tf_map() { terraform output -json "$1" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)['$2']))"; }
```

## 0. Antes de começar (uma vez)

**Decisões do PO** (sem elas o `prod.tfvars` não fecha):

| # | Decisão | Onde entra |
|---|---|---|
| D12 / P5 | Região (`sa-east-1`) e porte (`enxuto`, recomendado, ou `completo`) | `region` e `porte` |
| P6 | Domínio (ex.: `sussurro.app`) e DNS no Route 53 (recomendado) ou fora | `domain_name`, `dns_mode`, `create_dns_zone` |
| P7 | Orçamento mensal (200 no enxuto, 350 no completo) | `monthly_budget_usd` do bootstrap |
| L3 | Guarda de registros de acesso (Marco Civil, art. 15) | `access_log_retention_enabled` (§17); fica `false` até decidir |
| - | E-mails de alarme, de custo e de moderação | `alarm_email`, `cost_alert_email`, `moderation_email` |

**Contas**: AWS (usuário root com MFA e sem chaves; acesso do dia a dia pelo IAM Identity Center, com um usuário administrador), registrador do domínio, GitHub, Expo, Apple Developer, Google Play Console e, se for usar, Sentry.

**Ferramentas no PC** (todas oficiais; nenhuma entra no repositório):
- Terraform **1.16.6** exato (`terraform version`); o código recusa outra minor.
- AWS CLI v2 (`aws --version`), com um perfil do Identity Center: `aws configure sso --profile sussurro-admin`.
- Docker Desktop com buildx (`docker buildx version`) e emulação ARM64 (já vem no Docker Desktop).
- Node 26.13.0 e pnpm 12.13.0 (os mesmos do projeto).

Em todo terminal da operação:

```bash
export AWS_PROFILE=sussurro-admin AWS_REGION=sa-east-1
aws sso login
aws sts get-caller-identity   # confira: "Account" é a conta da produção
```

## 1. Bootstrap (uma vez; precisa de autorização)

Cria o bucket do state, os orçamentos de custo (7.9), o provedor OIDC do GitHub e a zona do Route 53. Custo próprio: ~US$ 0,50/mês (zona DNS) e centavos de S3.

```bash
cd infra/terraform/bootstrap
cp bootstrap.tfvars.example bootstrap.tfvars    # preencha: conta, e-mail de custo, orçamento, domínio
terraform init                                  # state LOCAL só neste primeiro passo
terraform plan -var-file=bootstrap.tfvars -out=bootstrap.tfplan
```

Confira no plano: 1 bucket `sussurro-tfstate-<conta>` e os recursos dele, 2 orçamentos, o monitor e a assinatura de anomalias, o provedor OIDC e a zona. **Nada de ECS, RDS ou CloudFront.** Com a autorização do PO:

```bash
terraform apply bootstrap.tfplan
terraform output   # anote state_bucket_name e route53_name_servers
```

Erro "Limit exceeded on dimensional spend monitor creation": a conta já tem o monitor padrão de anomalias. Copie o ARN dele (console do Billing → Cost Anomaly Detection → Monitores) para `anomaly_monitor_arn` no `bootstrap.tfvars` e rode `plan`/`apply` de novo.

Leve o state para o S3:
1. Em `bootstrap/backend.tf`, descomente o bloco e troque `<id-da-conta>` pela conta.
2. `terraform init -migrate-state` e responda `yes`.
3. `terraform plan -var-file=bootstrap.tfvars` deve dizer "No changes". Só então apague `terraform.tfstate` e `terraform.tfstate.backup` desta pasta.

**DNS**: no registrador (ex.: registro.br), troque os servidores de nome do domínio pelos 4 de `route53_name_servers`. Espere a propagação: `nslookup -type=NS <domínio>` mostra os da AWS (minutos a algumas horas). Não siga para o passo 3 antes disso, ou a validação dos certificados fica esperando.

**Lock dos providers**: o `.terraform.lock.hcl` de `bootstrap/` e de `envs/prod/` vem do Git (gerado pelo job `infra` do CI, sem credencial; `infra/terraform/README.md`, "Versões"). O `terraform init` usa as versões e os hashes dele. Se o `git status` mostrar o `.terraform.lock.hcl` alterado depois de um `init`, pare: a versão de um provider mudou sem o lock acompanhar, e isso volta para o DevOps.

## 2. Chave do CloudFront (uma vez, e em cada rotação)

As URLs de mídia são assinadas pela API com uma chave RSA 2048; o CloudFront confere com a chave pública. Gere o par **fora da pasta do repositório** (o `.gitignore` não cobre `*.pem`):

```bash
mkdir -p ~/sussurro-chaves && cd ~/sussurro-chaves
node -e "const c=require('node:crypto'),f=require('node:fs');const k=c.generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});f.writeFileSync('cloudfront-k1.pub.pem',k.publicKey);f.writeFileSync('cloudfront-k1.key.pem',k.privateKey,{mode:0o600})"
```

- `cloudfront-k1.pub.pem` (pública, não é segredo) vai para `cloudfront_public_keys.k1` no `prod.tfvars`.
- `cloudfront-k1.key.pem` (privada) vai para o segredo `cloudfront-private-key` no passo 5. Depois, guarde-a no gerenciador de senhas e apague o arquivo.

## 3. Primeiro apply da produção, sem os serviços (precisa de autorização)

```bash
cd infra/terraform/envs/prod
cp backend.hcl.example backend.hcl        # bucket = saída state_bucket_name do bootstrap
cp prod.tfvars.example prod.tfvars        # preencha tudo; services_enabled = false
terraform init -backend-config=backend.hcl
```

No `prod.tfvars`: `image_tag` é o SHA (12 caracteres) do commit que será publicado no passo 4 (`git rev-parse --short=12 HEAD`); o deploy exige o código commitado. `github_repository` fica vazio até existir o `deploy.yml`.

**DNS fora da AWS** (`dns_mode = "external"`): crie primeiro só os certificados e a identidade do SES, porque o apply completo espera a validação deles:

```bash
terraform apply -var-file=prod.tfvars -target=module.alb.aws_acm_certificate.this -target=module.media.aws_acm_certificate.media -target=module.ses
aws acm list-certificates --query "CertificateSummaryList[?DomainName=='api.<domínio>']"
aws acm describe-certificate --certificate-arn <arn> --query "Certificate.DomainValidationOptions[].ResourceRecord"
aws acm list-certificates --region us-east-1 --query "CertificateSummaryList[?DomainName=='media.<domínio>']"   # e o describe com --region us-east-1
```

Crie os CNAMEs de validação no provedor de DNS e siga. (Com Route 53 nada disso é preciso.)

Plano completo:

```bash
terraform plan -var-file=prod.tfvars -out=prod.tfplan
```

Confira: rede, ALB, RDS, Valkey, S3, CloudFront, filas, regra do EventBridge, segredos, roles, task definitions (`api`, `worker`, `migrate`, `db-bootstrap`) e alarmes; **nenhum `aws_ecs_service`** (por causa de `services_enabled = false`); nenhum `destroy`. Com a autorização do PO:

```bash
terraform apply prod.tfplan    # 15 a 30 min: o RDS, o CloudFront e a validação do ACM são os mais lentos
```

Depois:
- Confirme a inscrição do SNS: chega um e-mail "AWS Notification - Subscription Confirmation" no `alarm_email`; clique em "Confirm subscription". O alarme `sussurro-prod-api-sem-task-saudavel` dispara agora (ainda não há API) e volta a OK no passo 8.
- Com DNS externo: `terraform output -json dns_records_to_create` lista os registros de `api.`, `media.` e do DKIM para criar no provedor.

## 4. Imagens da API e do worker

No commit cujo SHA está em `image_tag`, na raiz do repositório:

```bash
SHA=$(git rev-parse --short=12 HEAD)          # tem de ser igual ao image_tag
REG=<conta>.dkr.ecr.sa-east-1.amazonaws.com
aws ecr get-login-password | docker login --username AWS --password-stdin $REG
docker buildx build --platform linux/arm64 -f apps/api/Dockerfile    -t $REG/sussurro-prod/api:$SHA    --push .
docker buildx build --platform linux/arm64 -f apps/worker/Dockerfile -t $REG/sussurro-prod/worker:$SHA --push .
aws ecr describe-image-scan-findings --repository-name sussurro-prod/api --image-id imageTag=$SHA --query "imageScanFindings.findingSeverityCounts"
```

As tags são imutáveis: o mesmo SHA não pode ser publicado duas vezes. Achado CRITICAL na varredura do ECR: pare e leve ao DevOps.

**Achados aceitos** (revisados pelo `seguranca` em 2026-10-31; não param o deploy). Qualquer outro achado alto ou crítico para o deploy.

| Achado | Pacote nas imagens | Por que é aceito | Até quando |
|---|---|---|---|
| GHSA-g3hv-75wg-m249 (moderada) | `minimatch` 10.2.6, por `@sentry/nestjs` → `@sentry/node` → `@sentry/bundler-plugins` → `glob` | O `@sentry/node` só usa o `@sentry/bundler-plugins` nas entradas `bundler-plugin/*` (plugins de esbuild, rollup e vite), que a API e o worker não importam: nada roda em produção | Até o Sentry trazer `minimatch` 11.0.1 ou mais (grupo `sentry` do Dependabot) |
| GHSA-3g3m-2fjr-6pw4 (moderada) | `glob` 13.0.6, pelo mesmo caminho | O mesmo | Até o Sentry trazer `glob` 14.0.2 ou mais |

A varredura básica do ECR (`scan_on_push` do módulo `ecr`) olha os pacotes do sistema operacional da imagem; esses dois são pacotes npm e aparecem na varredura avançada (Amazon Inspector) ou num `trivy image`. A lista completa e a origem estão no `infra.md` §8.3.

**Teste local da imagem (7.6 CA)**, antes do primeiro push ou quando mudar o Dockerfile, com o compose no ar (`docker compose up -d --wait postgres valkey`; na sua máquina, sem `--platform` a imagem sai na arquitetura do PC):

```bash
docker buildx build -f apps/api/Dockerfile -t sussurro-api:local --load .
docker run --rm --entrypoint id sussurro-api:local                  # uid=1000(node): não é root
# NODE_ENV=development só neste teste: em production a API exige SES, CloudFront e o e-mail de moderação
docker run --rm -p 3000:3000 -e NODE_ENV=development -e DATABASE_URL=postgres://sussurro:sussurro@host.docker.internal:5432/sussurro \
  -e REDIS_URL=redis://host.docker.internal:6379 -e JWT_ACCESS_SECRET=$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))") \
  -e API_HOST=0.0.0.0 sussurro-api:local
curl -i http://localhost:3000/health/ready                           # 200 com {"status":"ok"}
docker run --rm -e DATABASE_URL=postgres://sussurro:sussurro@host.docker.internal:5432/sussurro sussurro-api:local node dist/migrate.js   # exit 0
```

O CI faz este teste em ARM64 nativo (job `images`, infra.md §4.1) na `main` e em todo PR que mexe nas imagens, já com `NODE_ENV=production`, raiz só leitura e init, como no ECS: build das duas imagens, `id` (`node`, uid 1000), a migration pela imagem duas vezes, o `/health/ready` 200, o worker no ar com os emuladores e o desligamento com `SIGTERM` saindo com 0. Um run verde na `main` no commit a publicar dispensa repetir o teste aqui; a varredura do ECR continua valendo.

## 5. Segredos manuais

```bash
cd infra/terraform/envs/prod
terraform output secrets_backend    # ssm (porte enxuto) ou secretsmanager (completo)
terraform output manual_secrets     # o que falta preencher
terraform output secret_names       # o nome exato de cada um
```

Os valores **nunca** aparecem na tela nem no histórico: gere direto numa variável e apague-a no fim.

| Segredo | Valor |
|---|---|
| `jwt-access-secret` | `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"` |
| `jwt-access-previous-secret` | nada agora: só é usado (e preenchido) na rotação do JWT (§13) |
| `cloudfront-private-key` | o arquivo `cloudfront-k1.key.pem` do passo 2 |
| `expo-access-token` (só com `expo_access_token_enabled`) | token de acesso do expo.dev (Account settings → Access tokens) |

Com `ssm`:

```bash
V=$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))")
aws ssm put-parameter --name /sussurro/prod/jwt-access-secret --type SecureString --overwrite --value "$V"; unset V
aws ssm put-parameter --name /sussurro/prod/cloudfront-private-key --type SecureString --overwrite --value file://$HOME/sussurro-chaves/cloudfront-k1.key.pem
```

Com `secretsmanager`:

```bash
V=$(node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))")
aws secretsmanager put-secret-value --secret-id sussurro/prod/jwt-access-secret --secret-string "$V"; unset V
aws secretsmanager put-secret-value --secret-id sussurro/prod/cloudfront-private-key --secret-string file://$HOME/sussurro-chaves/cloudfront-k1.key.pem
```

Confira sem mostrar o valor: `aws ssm get-parameter --name /sussurro/prod/jwt-access-secret --with-decryption --query "length(Parameter.Value)"` (ou `aws secretsmanager get-secret-value --secret-id ... --query "length(SecretString)"`): 64 para o JWT; acima de 1600 para a chave. Um valor que ficou `PREENCHER` (SSM) faz a API recusar a subida, com a mensagem no log.

Os segredos gerados (`database-url`, `database-url-migrator`, `database-app-password`, `database-migrator-password`, `redis-url`) já foram gravados pelo Terraform: não mexa neles à mão.

## 6. Usuários do banco (task `db-bootstrap`; no primeiro deploy e na rotação de senha)

Cria `sussurro_migrator` (dono do schema, roda as migrations) e `sussurro_app` (só leitura e escrita de dados; usado pela API e pelo worker). Usa a senha mestre que o próprio RDS guarda e rotaciona.

```bash
cd infra/terraform/envs/prod
CLUSTER=$(terraform output -raw ecs_cluster_name)
NET=$(terraform output -raw run_task_network_configuration)
TASK=$(aws ecs run-task --cluster $CLUSTER --launch-type FARGATE --platform-version LATEST \
  --task-definition $(tf_map task_definition_arns db_bootstrap) --network-configuration "$NET" \
  --query "tasks[0].taskArn" --output text)
aws ecs wait tasks-stopped --cluster $CLUSTER --tasks $TASK
aws ecs describe-tasks --cluster $CLUSTER --tasks $TASK --query "tasks[0].containers[0].exitCode"   # 0
aws logs tail /ecs/sussurro-prod-db-bootstrap --since 30m
```

O log termina com `db-bootstrap: usuarios sussurro_migrator e sussurro_app prontos`. Exit diferente de 0: o log mostra o erro do `psql`; rodar de novo é seguro (o script é idempotente).

## 7. Migrations (task `migrate`; em todo deploy que traz migration)

```bash
TASK=$(aws ecs run-task --cluster $CLUSTER --launch-type FARGATE --platform-version LATEST \
  --task-definition $(tf_map task_definition_arns migrate) --network-configuration "$NET" \
  --query "tasks[0].taskArn" --output text)
aws ecs wait tasks-stopped --cluster $CLUSTER --tasks $TASK
aws ecs describe-tasks --cluster $CLUSTER --tasks $TASK --query "tasks[0].containers[0].exitCode"   # 0
aws logs tail /ecs/sussurro-prod-migrate --since 30m
```

O log mostra `aplicando as migrations pendentes` e `migrations aplicadas em N ms`. Exit 1: **pare o deploy** (nada mudou nos serviços); o log tem o erro, sem a senha. As migrations pendentes rodam numa transação só: se uma falha, nenhuma fica aplicada pela metade.

Regras que valem para toda migration (infra.md §6.6):
- **expand/contract**: a migration precisa funcionar com o código da versão anterior (coluna nova nullable → deploy → backfill → obrigatória numa release seguinte). Assim o rolling e o rollback não quebram.
- Migration destrutiva (apagar coluna ou tabela, mudar tipo): antes, um snapshot manual: `aws rds create-db-snapshot --db-instance-identifier sussurro-prod --db-snapshot-identifier sussurro-prod-antes-<sha>` e `aws rds wait db-snapshot-available --db-snapshot-identifier sussurro-prod-antes-<sha>`.

## 8. Ligar os serviços (primeiro deploy)

Com os passos 4 a 7 feitos, troque `services_enabled = true` no `prod.tfvars`:

```bash
terraform plan -var-file=prod.tfvars -out=prod.tfplan    # confira: cria só os 2 serviços e o autoscaling da API
terraform apply prod.tfplan
aws ecs wait services-stable --cluster $CLUSTER --services sussurro-prod-api sussurro-prod-worker
curl -i https://api.<domínio>/health/ready       # 200, postgres e redis "up"
aws logs tail /ecs/sussurro-prod-worker --since 10m | grep "Worker iniciado"   # (production, vídeo: mediaconvert, push: expo)
```

`services-stable` demorou mais de 10 min ou o circuit breaker desfez o deploy: `aws ecs describe-services --cluster $CLUSTER --services sussurro-prod-api --query "services[0].events[:10]"` e o log do serviço. As causas mais comuns são segredo vazio (a task nem sobe: "ResourceInitializationError") e variável recusada pela validação do boot (o log diz qual).

## 9. Uma vez, depois do primeiro deploy

1. **CloudFront flat-rate (infra.md §9.2)**: console do CloudFront → Pricing plans → assinar o plano **Pro** para a distribuição `sussurro-prod` de mídia. Se o console pedir alguma mudança de configuração para aceitar o plano, não mude à mão: anote e leve ao DevOps (o Terraform desfaria).
2. **SES fora do sandbox**: console do SES (sa-east-1) → Account dashboard → Request production access (uso: e-mails transacionais de confirmação, redefinição de senha e moderação; volume baixo). Antes disso, só e-mails verificados recebem. Confira o DKIM: `aws sesv2 get-email-identity --email-identity <domínio> --query "DkimAttributes.Status"` → `SUCCESS`.
3. **DMARC** (recomendado, no DNS): TXT `_dmarc.<domínio>` com `v=DMARC1; p=none; rua=mailto:<e-mail do PO>`.
4. **Monitor externo** do `https://api.<domínio>/health` (UptimeRobot ou Better Stack grátis): a AWS não percebe DNS ou certificado quebrados.
5. **Testes de fumaça**:
   - PERM-16: `curl -I https://media.<domínio>/media/qualquer/full.jpg` → 403 (sem assinatura); pegue uma URL assinada no `GET /v1/posts/:id`, troque uma letra da `Signature` → 403; a original → 200; depois de 6 h → 403.
   - MID-14 (GPS no vídeo): o roteiro de [`testes.md` §8.2](../equipe/testes.md), com registro em `docs/evidencias/fase-7/MID-14/`.
   - E-mail: um cadastro novo recebe o e-mail de confirmação com o link.
   - Push: MAN-PUSH-01 com o build de preview (passo 10).
   - Denúncia: uma denúncia chega no `moderation_email`.
6. **Sentry** (D4): crie os projetos `sussurro-api` e `sussurro-worker`, ponha os DSNs em `sentry_dsn_api` e `sentry_dsn_worker`, rode `plan`/`apply` e o `update-service` do passo 11 (o DSN entra numa revisão nova).

## 10. App (EAS)

1. Variáveis do EAS (expo.dev → projeto → Environment variables), nos ambientes `preview` e `production`, conforme [`variaveis.md`](variaveis.md) (seção "App"): `EXPO_PUBLIC_API_URL` = `terraform output -raw api_url`.
2. Preview (homologação, aponta para a produção, infra.md §2): `pnpm --filter @sussurro/mobile eas build --profile preview --platform all`. Rode os roteiros MAN-* com contas de teste.
3. Loja: `pnpm --filter @sussurro/mobile eas build --profile production --platform all` e o envio do [`lojas.md`](lojas.md).

## 11. Deploy de rotina (versão nova)

1. CI verde na `main` no commit a publicar.
2. Passo 4 (imagens) com o SHA novo.
3. `image_tag = "<sha novo>"` no `prod.tfvars`; `terraform plan -var-file=prod.tfvars -out=prod.tfplan`. Confira: só **revisões novas** de `api`, `worker` e `migrate` (`aws_ecs_task_definition`, "must be replaced"), nada de `destroy` em outro recurso. `terraform apply prod.tfplan`.
4. Se a versão traz migration: passo 7 (com o snapshot, se for destrutiva). Exit 1 → pare aqui.
5. Troque a API e espere ficar estável:
   ```bash
   aws ecs update-service --cluster $CLUSTER --service sussurro-prod-api --task-definition $(tf_map task_definition_arns api) --query "service.taskDefinition"
   aws ecs wait services-stable --cluster $CLUSTER --services sussurro-prod-api
   ```
   O rolling sobe as tasks novas antes de tirar as velhas (100%/200%); se elas não ficarem saudáveis no `/health/ready`, o circuit breaker volta sozinho para a revisão anterior.
6. O mesmo para o worker (`sussurro-prod-worker`, `tf_map task_definition_arns worker`).
7. Confira: `curl -i https://api.<domínio>/health/ready` → 200; `aws logs tail /ecs/sussurro-prod-api --since 10m` sem erro; nenhum alarme no e-mail; a versão nova no Sentry (`sussurro-api@<sha>`).
8. Registre a data, o SHA e as revisões (`api:N`, `worker:N`) no histórico de deploys do PO.

Mudança só de configuração (variável de ambiente, DSN, `jwt_access_kid`): passos 3, 5, 6 e 7, sem imagem nova. Mudança de segredo sem mudar a task definition: `aws ecs update-service --cluster $CLUSTER --service <serviço> --force-new-deployment` (os segredos são lidos na subida da task).

## 12. Rollback

**Aplicação** (versão nova com bug, sem problema de banco), em menos de 5 min:

```bash
aws ecs list-task-definitions --family-prefix sussurro-prod-api --sort DESC --max-items 5   # a anterior é a segunda
aws ecs update-service --cluster $CLUSTER --service sussurro-prod-api --task-definition sussurro-prod-api:<rev-anterior>
aws ecs wait services-stable --cluster $CLUSTER --services sussurro-prod-api
```

O mesmo para o worker, se ele também mudou. As revisões antigas continuam ativas (o Terraform não as apaga: `skip_destroy`), e as imagens ficam no ECR (últimas 20). Depois, volte o `image_tag` do `prod.tfvars` para o SHA anterior e rode `plan`/`apply`: ele registra uma revisão igual à anterior e não mexe nos serviços. Assim o próximo apply não traz a versão com bug de volta.

**Migrations** não são revertidas (expand/contract torna isso desnecessário: o código anterior funciona com o schema novo). Se o dado foi corrompido: restauração (§14), sempre com o PO.

**Infraestrutura** (mudança no Terraform que deu errado): reverta o arquivo `.tf` e rode `plan`/`apply`. Recurso com `deletion_protection` ou `prevent_destroy` no caminho: pare e leve ao DevOps.

## 13. Rotação de segredos

Depois de qualquer troca, as tasks só pegam o valor novo ao subir: `update-service` (com revisão nova) ou `--force-new-deployment`.

**JWT** (`JWT_ACCESS_SECRET`; a cada 6 meses ou se vazar):
1. Copie o valor atual de `jwt-access-secret` para `jwt-access-previous-secret` (que existe sempre, vazio fora da rotação): `get-parameter --with-decryption` → `put-parameter`, ou `get-secret-value` → `put-secret-value`, sempre por variável, sem mostrar.
2. Gere o novo valor (passo 5) em `jwt-access-secret`. No `prod.tfvars`: `jwt_previous_enabled = true`, `jwt_previous_kid = "<kid atual>"` e `jwt_access_kid = "<kid novo>"` (ex.: de `k1` para `k2`). `plan`/`apply` registra uma revisão nova da API (que ainda **não** está no ar).
3. `update-service` da API (§11, passo 5). Durante o rolling, um token novo pode receber 401 numa task velha: o app renova sozinho. As tasks em execução seguem com o segredo que leram ao subir.
4. Depois de 15 min (validade do access token) e sem task velha no ar: `jwt_previous_enabled = false`, `plan`/`apply`, `update-service` da API. Se quiser, sobrescreva `jwt-access-previous-secret` com um valor aleatório descartável (ele não é mais injetado).

**Chave do CloudFront**:
1. Gere `cloudfront-k2` (passo 2). No `prod.tfvars`, acrescente `k2` em `cloudfront_public_keys` (mantenha `k1`); `plan`/`apply` (o key group passa a aceitar as duas).
2. Ponha a privada `k2` em `cloudfront-private-key`, troque `cloudfront_active_key = "k2"`, `plan`/`apply`, `update-service` da API.
3. Depois de 6 h (validade das URLs já emitidas), tire `k1` do mapa, `plan`/`apply`.

**Senhas do banco** (app e migrator; se vazarem, ou uma vez por ano), numa janela de pouco uso:
1. `terraform apply -var-file=prod.tfvars -replace=random_password.db_app -replace=random_password.db_migrator` (grava as novas nos segredos gerados).
2. Passo 6 (`db-bootstrap`), que troca as senhas no Postgres. As conexões já abertas seguem; as novas das tasks velhas falham até o passo 3.
3. `--force-new-deployment` da API e do worker, e `wait services-stable`.

**Senha mestre do RDS**: o próprio RDS rotaciona (a cada 7 dias); a task `db-bootstrap` lê o valor atual ao subir. Nada a fazer.

**Token do Valkey**: `terraform apply -var-file=prod.tfvars -replace=random_password.valkey_auth`. A estratégia `ROTATE` mantém o token antigo e o novo válidos; depois, `--force-new-deployment` da API e do worker.

**Token do Expo** (se usado): novo token no expo.dev → `expo-access-token` → `--force-new-deployment` do worker → revogue o antigo no expo.dev.

## 14. Restauração do banco (PITR)

Meta: RTO < 1 h, RPO de 5 min (infra.md §8). Exercício a cada trimestre, **com autorização do PO** (cria uma instância paga por algumas horas).

1. Escolha o momento (UTC) antes do problema.
2. Restaure numa instância nova, na mesma rede e com os mesmos parâmetros:
   ```bash
   aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier sussurro-prod \
     --target-db-instance-identifier sussurro-restore-<aaaammdd> --restore-time <2026-11-01T12:00:00Z> \
     --db-subnet-group-name sussurro-prod --vpc-security-group-ids <id do SG sussurro-prod-rds> \
     --db-parameter-group-name sussurro-prod-pg18 --no-publicly-accessible
   aws rds wait db-instance-available --db-instance-identifier sussurro-restore-<aaaammdd>
   ```
3. Confira os dados: rode uma task `migrate` apontando para a restaurada (exit 0 e nenhuma migration pendente) com o DevOps.
4. Troca (só em incidente real, com o PO): pare a escrita (`update-service --desired-count 0` na API e no worker), renomeie a instância antiga (`aws rds modify-db-instance --db-instance-identifier sussurro-prod --new-db-instance-identifier sussurro-prod-old --apply-immediately`) e a restaurada para `sussurro-prod` (o endereço DNS volta a ser o mesmo), e suba os serviços (`--desired-count` de antes).
5. Depois do incidente, o DevOps reconcilia o Terraform (`plan` precisa ficar sem mudanças antes de qualquer `apply`) e a instância `-old` é apagada (o snapshot final fica).
6. No exercício trimestral, só os passos 1 a 3, cronometrados; apague a restaurada no fim (`aws rds delete-db-instance --db-instance-identifier sussurro-restore-<aaaammdd> --skip-final-snapshot`).

## 15. Alarmes e incidentes

| Alarme | Primeiro passo |
|---|---|
| `*-dlq-*` | Mensagem que falhou 3 vezes. Veja o log do worker na hora do alarme. As mensagens só têm ids: `aws sqs receive-message --queue-url <url da dlq> --max-number-of-messages 10`. Corrigida a causa, devolva-as: `aws sqs start-message-move-task --source-arn <arn da dlq>`. Exceção: a DLQ da `video-events` não volta para a fila (a política dela só aceita a regra do EventBridge, então o reenvio é negado); o reel já virou `failed` pelo tempo esgotado e a pessoa usa "Tentar de novo": analise e apague (`aws sqs purge-queue`) |
| `*-fila-parada-*` | Worker parado ou lento: `aws ecs describe-services ... sussurro-prod-worker` (tasks rodando?) e o log |
| `*-api-5xx`, `*-api-latencia-p95` | `aws logs tail /ecs/sussurro-prod-api --since 30m --filter-pattern '{ $.level >= 50 }'` (com logs Infrequent Access, se o filtro não for aceito, use o Logs Insights: `filter level >= 50`) e o Sentry; deploy recente → rollback (§12) |
| `*-api-sem-task-saudavel`, `*-api-tasks-nao-saudaveis` | `/health/ready` falhando: Postgres ou Valkey fora? (o JSON da resposta diz qual) |
| `*-rds-*`, `*-valkey-*` | Métrica no console; conexões altas: muitas tasks? (pool de 10 por task) |
| `*-mediaconvert-erros` | O reel virou `failed`; o log do worker tem o código do erro do MediaConvert |
| Orçamento (e-mail do Budgets) | Cost Explorer por serviço; MediaConvert/CloudFront alto: abuso de vídeo (R10) |

## 16. Trocar de porte (P5)

De `enxuto` para `completo` com o ambiente no ar:
1. No `prod.tfvars`: `porte = "completo"` e, para não recriar os segredos nem os log groups, `secrets_backend = "ssm"` e `log_group_class = "INFREQUENT_ACCESS"` (os do enxuto). Migrar os segredos para o Secrets Manager é outra operação, planejada com o DevOps.
2. `plan`: o RDS muda de classe e vira Multi-AZ (em modificação, sem recriar: se o plano disser "must be replaced", pare), o autoscaling da API passa a mínimo 2, e o worker sai do Spot. `apply`.
3. O RDS aplica a mudança na próxima janela de manutenção (domingo, 04:30 de Brasília). Para aplicar já: `aws rds modify-db-instance --db-instance-identifier sussurro-prod --apply-immediately` com a mesma classe e `--multi-az` (o Multi-AZ entra sem parada; a troca de classe tem um failover curto).
4. Troque o `monthly_budget_usd` do bootstrap (350) e aplique o bootstrap.

## 17. Guarda dos registros de acesso (L3, Marco Civil art. 15)

**Desligada.** Só ligue depois de o PO confirmar (com orientação jurídica) **e** de a Política de Privacidade estar atualizada (texto abaixo).

Para ligar: `access_log_retention_enabled = true` (e, se quiser restringir a leitura a uma role usada só para ordens judiciais, `access_log_reader_arns`), `plan`/`apply`. Cria o bucket `sussurro-prod-alb-access-logs-<conta>` (privado, SSE-S3, só TLS, versionado, apagado depois de 185 dias) e liga os logs do ALB nele. Custo: ~US$ 0,50 a 1/mês no lançamento. Confira depois de alguns minutos: `aws s3 ls s3://sussurro-prod-alb-access-logs-<conta>/alb/AWSLogs/<conta>/ --recursive | head`.

O que os logs do ALB guardam, por requisição: data e hora (UTC), IP e porta de quem acessou, método e URL **com a query string** (por exemplo, o termo de uma busca de criador e cursores de paginação), código de resposta, bytes, tempos, user agent e dados do TLS. Não guardam o corpo da requisição, o token nem o id da conta.

**Limite importante**: o art. 15 fala em "data e hora de uso de uma aplicação a partir de um IP". Os logs do ALB têm isso, mas não dizem **qual conta** fez cada acesso. Uma ordem judicial costuma pedir os IPs de uma conta; para responder, seria preciso um registro na aplicação com conta, IP e data/hora guardado por 6 meses (mudança de código fora da Fase 7). Decisão do PO com o jurídico.

**O que muda na Política de Privacidade** (`C:\dev\sussurro-site`, `src/privacidade.html`), se ligar:
- Novo item "Registros de acesso": guardamos data e hora, endereço IP e porta, o endereço acessado na API (com os parâmetros da URL, como termos de busca), o resultado e o identificador do aplicativo/navegador (user agent) de cada acesso à API.
- Finalidade e base legal: cumprir a obrigação de guarda do Marco Civil da Internet (Lei 12.965/2014, art. 15), base legal de cumprimento de obrigação legal (LGPD, art. 7º, II).
- Prazo: 6 meses, apagados automaticamente depois disso.
- Acesso: em sigilo, em ambiente controlado e criptografado, na AWS em São Paulo (sa-east-1); só fornecidos mediante ordem judicial (Marco Civil, art. 15 §3 e art. 22) ou requisição legal.
- Independente do L3: hoje o log da aplicação (30 dias, CloudWatch) já registra os cabeçalhos das requisições, inclusive o IP de origem que o ALB acrescenta (`X-Forwarded-For`) e o user agent. A política deve mencionar esse log técnico e o prazo de 30 dias (ou a equipe passa a tirar esses cabeçalhos do log, decisão do PO).

## 18. Custo (USD/mês, sa-east-1, sem impostos)

| | enxuto (padrão) | completo |
|---|---|---|
| Fargate API | 1 × 0,5 vCPU/1 GB = 24,80 | 2 × = 49,60 |
| Fargate worker | Spot ≈ 7,40 | 24,80 |
| IPv4 públicos (tasks + ALB) | 4 × 3,65 = 14,60 | 5 × 3,65 = 18,25 |
| ALB | ~33 | ~33 |
| RDS | t4g.micro Single-AZ + 20 GB ≈ 29 | t4g.small Multi-AZ + 20 GB ≈ 109 |
| Valkey | t4g.micro = 17,50 | 17,50 |
| S3 + CloudFront Pro (flat-rate) | 3 + 15 | 3 + 15 |
| MediaConvert (500 min) | 5 | 5 |
| Segredos | SSM grátis + 1 do RDS = 0,40 | 8 × 0,40 = 3,20 |
| CloudWatch (logs + ~20 alarmes) | ~4 (logs IA) | ~7,50 |
| ECR, Route 53 (zona 0,50), EventBridge, SES, SQS | ~1,50 | ~1,50 |
| **Total AWS** | **~US$ 155 a 160** | **~US$ 285 a 290** |

Com 10× o uso (infra.md §9): ~US$ 975. Fora da AWS no lançamento: ~US$ 53 (Apple, EAS Starter, Sentry Team, domínio). Some 15 a 20% de impostos. **Até o primeiro apply autorizado, o custo é US$ 0.**
