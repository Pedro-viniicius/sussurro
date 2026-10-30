# Variáveis de ambiente da produção: de onde vem cada uma

> Fase 7 (backlog 7.5). Fonte: `apps/api/src/config/env.schema.ts` e `apps/worker/src/config/env.schema.ts` (toda variável que eles leem está aqui) e `infra/terraform/envs/prod/main.tf` (locals `*_environment` e `*_secrets`).
> Nenhum valor real está no repositório. Os nomes usam o prefixo `sussurro-prod` (`project` + `environment`).

Legenda da coluna **Origem**:
- **task**: valor fixo ou calculado pelo Terraform, em texto claro na task definition (nunca segredo).
- **tfvars**: variável do `prod.tfvars` (fora do Git), em texto claro na task definition.
- **segredo gerado**: o Terraform gera ou monta o valor e grava no Secrets Manager ou no SSM (pelo porte); o ECS injeta na subida.
- **segredo manual**: o Terraform cria vazio; o valor é posto à mão (runbook, passo 5); o ECS injeta na subida.
- **padrão**: não é definida na produção; vale o padrão do `env.schema.ts`.
- **não se aplica**: só existe em desenvolvimento ou nos testes; na produção fica ausente.

Os segredos ficam em `/sussurro/prod/<nome>` (SSM, porte enxuto) ou `sussurro/prod/<nome>` (Secrets Manager, porte completo). A saída `secret_names` do Terraform lista os nomes exatos.

## API (`apps/api`, serviço `sussurro-prod-api`)

| Variável | Valor na produção | Origem |
|---|---|---|
| `NODE_ENV` | `production` | task |
| `LOG_LEVEL` | `info` | task |
| `API_HOST` | `0.0.0.0` | task |
| `API_PORT` | `3000` (porta do target group) | task |
| `TRUST_PROXY_HOPS` | `1` (ALB) | task |
| `DATABASE_URL` | `postgres://sussurro_app:<senha>@<rds>:5432/sussurro?sslmode=verify-full` | segredo gerado `database-url` (senha `random_password.db_app`) |
| `REDIS_URL` | `rediss://:<token>@<valkey>:6379` | segredo gerado `redis-url` (token `random_password.valkey_auth`) |
| `JWT_ACCESS_SECRET` | 48 bytes aleatórios em base64url | segredo manual `jwt-access-secret` |
| `JWT_ACCESS_KID` | `k1` | tfvars `jwt_access_kid` |
| `JWT_ACCESS_PREVIOUS_SECRET` | só durante a rotação | segredo manual `jwt-access-previous-secret` (existe sempre; só é injetado com `jwt_previous_enabled = true`) |
| `JWT_ACCESS_PREVIOUS_KID` | só durante a rotação | tfvars `jwt_previous_kid` (com `jwt_previous_enabled = true`) |
| `ACCESS_TOKEN_TTL_S`, `REFRESH_TOKEN_TTL_S`, `REFRESH_REUSE_GRACE_S` | 900, 2592000, 20 | padrão |
| `EMAIL_VERIFICATION_TTL_S`, `PASSWORD_RESET_TTL_S` | 86400, 3600 | padrão |
| `EMAIL_SENDER` | `ses` (obrigatório em produção) | task |
| `EMAIL_FROM` | `Sussurro <nao-responda@<domínio>>` | task (domínio do tfvars `domain_name`; pode ser trocado por `email_from`) |
| `EMAIL_LINK_BASE_URL` | `sussurro://` | tfvars `email_link_base_url` (decisão pendente: ver runbook, "Pendências do PO") |
| `MODERATION_EMAIL` | e-mail de moderação | tfvars `moderation_email` (obrigatória em produção) |
| `AWS_REGION` | `sa-east-1` | task (tfvars `region`, D12) |
| `FEED_WINDOW_HOURS` | 72 | padrão |
| `PROX_TOKEN_TTL_S`, `PROX_RECENT_TTL_S`, `PROX_SCREEN_TTL_S` | 30, 120, 30 | padrão |
| `CONNECTION_REQUEST_TTL_S`, `CONNECTION_DECLINE_COOLDOWN_S` | 120, 3600 | padrão |
| `PROXIMITY_STORE` | `redis` (obrigatório em produção) | task |
| `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL_SQS`, `S3_PUBLIC_ENDPOINT_URL` | ausentes (AWS real) | não se aplica |
| `S3_FORCE_PATH_STYLE` | `false` | padrão |
| `S3_BUCKET_MEDIA` | `sussurro-prod-media-<conta>` | task (saída do módulo `media`) |
| `SQS_QUEUE_MEDIA_JOBS` | `sussurro-prod-media-jobs` | task (módulo `queues`) |
| `SQS_QUEUE_PUSH` | `sussurro-prod-push` | task (módulo `queues`) |
| `PRESIGN_PUT_TTL_S`, `MEDIA_URL_TTL_S` | 600, 21600 | padrão |
| `MEDIA_URL_SIGNER` | `cloudfront` (obrigatório em produção) | task |
| `CLOUDFRONT_DOMAIN` | `media.<domínio>` | task |
| `CLOUDFRONT_KEY_PAIR_ID` | id da chave pública ativa | task (`aws_cloudfront_public_key`, tfvars `cloudfront_active_key`) |
| `CLOUDFRONT_PRIVATE_KEY` | PEM da chave privada RSA 2048 | segredo manual `cloudfront-private-key` |
| `SENTRY_DSN` | DSN do projeto `sussurro-api` ou ausente (D4) | tfvars `sentry_dsn_api` (não é segredo; fica fora do Git) |
| `SENTRY_ENVIRONMENT` | `production` | task |
| `SENTRY_RELEASE` | `sussurro-api@<sha>` | task (tfvars `image_tag`) |
| `SENTRY_TRACES_SAMPLE_RATE` | 0.05 | tfvars `sentry_traces_sample_rate` |
| `OTEL_ENABLED` | `false` | task |

A task de migration (`sussurro-prod-migrate`, mesma imagem, `node dist/migrate.js`) recebe só `NODE_ENV=production` (task) e `DATABASE_URL` do segredo gerado `database-url-migrator` (usuário `sussurro_migrator`).

## Worker (`apps/worker`, serviço `sussurro-prod-worker`)

| Variável | Valor na produção | Origem |
|---|---|---|
| `NODE_ENV` | `production` | task |
| `LOG_LEVEL` | `info` | task |
| `DATABASE_URL` | a mesma da API (`sussurro_app`) | segredo gerado `database-url` |
| `REDIS_URL` | a mesma da API | segredo gerado `redis-url` |
| `SENTRY_DSN` | DSN do projeto `sussurro-worker` ou ausente | tfvars `sentry_dsn_worker` |
| `SENTRY_ENVIRONMENT` | `production` | task |
| `SENTRY_RELEASE` | `sussurro-worker@<sha>` | task (tfvars `image_tag`) |
| `SENTRY_TRACES_SAMPLE_RATE` | 0.05 | tfvars `sentry_traces_sample_rate` |
| `OTEL_ENABLED` | `false` | task |
| `ACCOUNT_PURGE_AFTER_DAYS`, `MAINTENANCE_INTERVAL_MS` | 30, 3600000 | padrão |
| `AWS_REGION` | `sa-east-1` | task |
| `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL_SQS` | ausentes (AWS real) | não se aplica |
| `S3_FORCE_PATH_STYLE` | `false` | padrão |
| `S3_BUCKET_MEDIA` | `sussurro-prod-media-<conta>` | task |
| `SQS_QUEUE_MEDIA_JOBS` | `sussurro-prod-media-jobs` | task |
| `MEDIA_JOBS_CONCURRENCY`, `MEDIA_JOBS_WAIT_S`, `MEDIA_JOBS_MAX_ATTEMPTS` | 2, 20, 3 (= `maxReceiveCount` das DLQs) | padrão |
| `MEDIA_MAX_INPUT_PIXELS` | 40000000 | padrão |
| `DRAFT_TTL_HOURS`, `MEDIA_PROCESSING_TIMEOUT_MIN` | 24, 60 | padrão |
| `VIDEO_PROCESSOR` | `mediaconvert` (obrigatório em produção) | task |
| `MEDIACONVERT_ROLE_ARN` | `arn:aws:iam::<conta>:role/sussurro-prod-mediaconvert` | task (módulo `mediaconvert`) |
| `MEDIACONVERT_QUEUE_ARN` | ausente = fila `Default` | tfvars `mediaconvert_queue_arn` (opcional) |
| `SQS_QUEUE_VIDEO_EVENTS` | `sussurro-prod-video-events` | task |
| `SQS_QUEUE_PUSH` | `sussurro-prod-push` | task |
| `PUSH_SENDER` | `expo` (obrigatório em produção) | task |
| `EXPO_ACCESS_TOKEN` | só com a segurança reforçada de push do Expo | segredo manual `expo-access-token` (com `expo_access_token_enabled = true`) |
| `PUSH_JOBS_CONCURRENCY`, `PUSH_JOBS_MAX_ATTEMPTS`, `PUSH_RECEIPTS_INTERVAL_MS` | 10, 3, 900000 | padrão |

## Fora dos `env.schema.ts`

| Variável | Onde | Origem |
|---|---|---|
| `NODE_EXTRA_CA_CERTS` | API, worker e migration | `ENV` dos Dockerfiles: o bundle de CAs do RDS, para o `sslmode=verify-full` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | API e worker | não se aplica: na produção as credenciais vêm da task role (o SDK as pega sozinho). Nunca defina na task |
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGSSLMODE`, `PGAPPNAME` | task `db-bootstrap` | task |
| `PGUSER`, `PGPASSWORD` | task `db-bootstrap` | segredo do usuário mestre, gerenciado e rotacionado pelo RDS (campos `username` e `password`) |
| `APP_DB_PASSWORD`, `MIGRATOR_DB_PASSWORD` | task `db-bootstrap` | segredos gerados `database-app-password` e `database-migrator-password` |
| `TEST_DB`, `SEED_PASSWORD`, `SEED_VOLUME`, `PGLITE_PORT`, `PGLITE_DATA_DIR`, `POSTGRES_PASSWORD`, `LOCALSTACK_AUTH_TOKEN` | testes e desenvolvimento | não se aplica (o seed recusa `NODE_ENV=production`) |

## App (EAS Environment Variables, perfis `preview` e `production`)

Nada disso fica no `eas.json` nem no repositório.

| Variável | Valor | Visibilidade no EAS |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | saída `api_url` do Terraform (`https://api.<domínio>`) | plain text (vai para o bundle) |
| `EXPO_PUBLIC_SENTRY_DSN` | DSN do projeto `sussurro-mobile` (vazio = desligado) | plain text |
| `EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` | 0.05 | plain text |
| `EXPO_PUBLIC_DEV_TOOLS` | nunca no `production` | não definir |
| `APP_VARIANT` | vem do `eas.json` (`preview` ou `production`) | já no `eas.json` |
| `EAS_PROJECT_ID` | opcional: troca o projeto do expo.dev (padrão fixo no `app.config.ts`) | plain text (só no build) |
| `GOOGLE_SERVICES_JSON` | `google-services.json` do Firebase | arquivo, secret |
| `SENTRY_ORG`, `SENTRY_PROJECT` | organização e projeto do Sentry | plain text (só no build) |
| `SENTRY_AUTH_TOKEN` | token de upload dos source maps | **secret** |
