# Terraform da produção (Fase 7)

Só código. **Nunca rode `terraform apply`, `destroy`, `import` ou `state` sem autorização explícita do PO.** Até essa autorização, o custo AWS é zero. O passo a passo do primeiro deploy, do deploy de rotina, do rollback e da rotação de segredos está em [`docs/deploy/runbook.md`](../../docs/deploy/runbook.md). De onde vem cada variável de ambiente da API e do worker: [`docs/deploy/variaveis.md`](../../docs/deploy/variaveis.md).

## Layout (infra.md §6.2)

| Pasta                   | O que cria                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrap/`            | Aplicado uma vez: bucket do state (versioning, SSE, só TLS), orçamentos e anomalias de custo (7.9), provedor OIDC do GitHub e zona do Route 53      |
| `envs/prod/`            | A produção: compõe os módulos abaixo. Backend S3 com lock nativo (`use_lockfile`), `prod.tfvars.example` e `backend.hcl.example`                    |
| `envs/staging/`         | Vazio na v1 (infra.md §2)                                                                                                                           |
| `modules/network`       | VPC em 2 AZs **sem NAT Gateway**: subnets públicas (ALB e tasks com IP público) e privadas isoladas (RDS e Valkey), S3 gateway endpoint e os SGs    |
| `modules/ecr`           | Repositórios `api` e `worker`: tags imutáveis, varredura na entrada, mantém 20 imagens                                                              |
| `modules/ecs-cluster`   | Cluster com FARGATE e FARGATE_SPOT                                                                                                                  |
| `modules/ecs-service`   | Genérico: log group, execution role só com os segredos da task, task definition ARM64 (raiz só leitura, init) e, se pedido, serviço e autoscaling   |
| `modules/alb`           | ALB, TLS 1.2+ (ACM), redirect 80 → 443, target group em `/health/ready` e, com L3 ligado, logs de acesso                                            |
| `modules/rds`           | PostgreSQL 18 gp3 criptografado, `rds.force_ssl`, backups de 14 dias com PITR, deletion protection e senha mestre gerenciada pelo RDS               |
| `modules/elasticache`   | Valkey 8 em nó único, TLS obrigatório, criptografia em repouso e AUTH                                                                               |
| `modules/media`         | S3 privado (BPA, SSE-S3, versioning, `incoming/` em 1 dia, versões antigas em 7) e CloudFront com OAC, key group e URL assinada; ACM em us-east-1   |
| `modules/queues`        | `media-jobs`, `video-events` e `push`, cada uma com DLQ (`maxReceiveCount = 3`, 14 dias), SSE-SQS e só TLS; a `video-events` só aceita a regra      |
| `modules/mediaconvert`  | Role do MediaConvert (lê `incoming/*`, grava `media/*`) e a regra do EventBridge → `video-events`                                                   |
| `modules/secrets`       | Segredos no Secrets Manager ou no SSM (pelo porte): gerados pelo Terraform ou criados vazios para preencher à mão                                   |
| `modules/iam`           | Task roles da API e do worker (infra.md §6.5) e a role de deploy do GitHub (OIDC, só a `main`)                                                      |
| `modules/observability` | SNS → e-mail e ~20 alarmes: ALB, ECS, RDS, Valkey, DLQs, fila parada e jobs do MediaConvert com erro                                                |
| `modules/ses`           | Identidade do domínio no SES com DKIM (D6)                                                                                                          |
| `modules/dns`           | Registros no Route 53: `api.`, `media.` e os CNAMEs do DKIM (só com `dns_mode = route53`)                                                           |
| `modules/access-logs`   | L3 (Marco Civil, art. 15): bucket dos logs de acesso do ALB com guarda de 6 meses e acesso restrito. **Desligado** (`access_log_retention_enabled`) |
| `modules/budgets`       | Orçamento mensal (50%, 80% e 100% real; 100% previsto), orçamento de MediaConvert + CloudFront e Cost Anomaly Detection                             |

## Porte (P5/D12): uma variável

`porte = "enxuto"` (padrão, a recomendação do P5) ou `"completo"`. O PO ainda confirma.

| Item                | enxuto (~US$ 155/mês)         | completo (~US$ 285/mês)     |
| ------------------- | ----------------------------- | --------------------------- |
| RDS                 | `db.t4g.micro`, Single-AZ     | `db.t4g.small`, Multi-AZ    |
| API                 | 1 task (autoscaling de 1 a 3) | 2 tasks (autoscaling 2 a 4) |
| Worker              | 1 task no FARGATE_SPOT        | 1 task no FARGATE           |
| Segredos            | SSM Parameter Store (grátis)  | Secrets Manager             |
| Logs                | CloudWatch Infrequent Access  | CloudWatch Standard         |
| Valkey, ALB, CDN... | iguais                        | iguais                      |

Ao subir de porte com o ambiente no ar, fixe `secrets_backend` e `log_group_class` nos valores atuais: trocar o local dos segredos recria todos (os manuais precisam ser preenchidos de novo) e trocar a classe do log group apaga o histórico (runbook, "Trocar de porte").

## Versões

- Terraform `~> 1.16.0` (a 1.17 é nova demais; infra.md §6.2). O CI usa a 1.16.6.
- Provider AWS fixado em `6.69.1` e random em `3.9.1` nas raízes; os módulos aceitam `>= 6.68.0, < 7.0.0`. O primeiro `terraform init` com credencial gera o `.terraform.lock.hcl` de cada raiz, que deve ser versionado (`terraform providers lock -platform=linux_amd64 -platform=windows_amd64 -platform=darwin_arm64`).
- TFLint v0.64.0 com o ruleset da AWS 0.49.0 (`.tflint.hcl`); Trivy 0.76.0. Todas as versões têm 14 dias ou mais, a mesma margem do Dependabot.

## Validar sem credencial (o que o CI roda no job `infra`)

```bash
terraform fmt -check -recursive infra/terraform
terraform -chdir=infra/terraform/bootstrap init -backend=false && terraform -chdir=infra/terraform/bootstrap validate
terraform -chdir=infra/terraform/envs/prod init -backend=false && terraform -chdir=infra/terraform/envs/prod validate
cd infra/terraform && tflint --init --config="$PWD/.tflint.hcl" && tflint --recursive --config="$PWD/.tflint.hcl"
docker run --rm -v "$PWD:/src:ro" -w /src aquasec/trivy:0.76.0 config --severity HIGH,CRITICAL --skip-dirs node_modules --skip-dirs docs .
```

`plan` e `apply` exigem credencial da AWS e autorização do PO (runbook).

## Achados do Trivy aceitos (com `#trivy:ignore` no código)

| Achado                                     | Onde                           | Por quê                                                                                                                  |
| ------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| AVD-AWS-0107 (entrada de 0.0.0.0/0)        | SG do ALB, portas 443 e 80     | A API é pública; o 80 só redireciona para o 443                                                                          |
| AVD-AWS-0104 (saída para 0.0.0.0/0)        | SGs da API, do worker e do ops | Só a porta 443: APIs da AWS, Expo Push e Sentry, sem NAT nem interface endpoints (infra.md §6.3)                         |
| AVD-AWS-0053 (ALB público)                 | `modules/alb`                  | É a porta de entrada da API                                                                                              |
| AVD-AWS-0057 (curinga no IAM)              | Políticas de task, deploy e MC | Só onde a AWS exige `*` (`ecr:GetAuthorizationToken`, `ecs:RegisterTaskDefinition`) ou em prefixos de objeto (`media/*`) |
| AVD-AWS-0132 (S3 sem chave KMS própria)    | Buckets de mídia, logs e state | SSE-S3 (infra.md §6.4); o ALB só grava logs com SSE-S3, e o CloudFront com OAC e o MediaConvert precisariam da chave KMS |
| AVD-AWS-0135 (SQS sem chave KMS própria)   | Filas e DLQs                   | SSE-SQS sem custo; as mensagens só levam ids (ADR 0011)                                                                  |
| AVD-AWS-0097 (curinga na política da fila) | Políticas das filas            | O `sqs:*` e o principal `*` só aparecem em instruções Deny (sem TLS; remetente que não é a regra do EventBridge)         |
| AVD-AWS-0095 (SNS sem criptografia)        | Tópico dos alarmes             | As mensagens só têm nomes de métricas; a chave `aws/sns` impede o CloudWatch de publicar (exigiria uma chave KMS paga)   |
| AVD-AWS-0011 (CloudFront sem WAF)          | Distribuição de mídia          | WAF fora da v1 (infra.md §6.4): sem URL assinada válida a resposta já é 403, e o abuso de custo tem orçamento próprio    |

Achados de severidade baixa ou média (flow logs, logs de acesso do S3 e do CloudFront, Container Insights, chave KMS própria nos log groups e nos segredos) ficam como estão, pelo custo e pela minimização de dados.
