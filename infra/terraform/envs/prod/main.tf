# Produção do Sussurro (Fase 7, infra.md §6). Só código: NUNCA `terraform apply` sem autorização
# explícita do PO. Ordem do primeiro deploy e operação: docs/deploy/runbook.md.

data "aws_route53_zone" "this" {
  count = local.use_route53 ? 1 : 0

  name         = var.domain_name
  private_zone = false
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.github_repository == "" ? 0 : 1

  url = "https://token.actions.githubusercontent.com"
}

# --- Rede, imagens e cluster (7.1) ---

module "network" {
  source = "../../modules/network"

  name               = local.name
  cidr_block         = var.vpc_cidr
  availability_zones = var.availability_zones
  api_port           = local.api_port
}

module "ecr" {
  source = "../../modules/ecr"

  name         = local.name
  repositories = ["api", "worker"]
  keep_images  = 20
}

module "ecs_cluster" {
  source = "../../modules/ecs-cluster"

  name = local.name
}

# --- Guarda dos registros de acesso (L3; desligada até o PO confirmar) ---

module "access_logs" {
  source = "../../modules/access-logs"
  count  = var.access_log_retention_enabled ? 1 : 0

  bucket_name    = "${local.name}-alb-access-logs-${var.aws_account_id}"
  aws_account_id = var.aws_account_id
  prefix         = "alb"
  retention_days = var.access_log_retention_days
  reader_arns    = var.access_log_reader_arns
}

module "alb" {
  source = "../../modules/alb"

  name                  = local.name
  vpc_id                = module.network.vpc_id
  public_subnet_ids     = module.network.public_subnet_ids
  security_group_id     = module.network.security_group_ids["alb"]
  domain_name           = local.api_domain
  validate_with_route53 = local.use_route53
  route53_zone_id       = local.route53_zone_id
  target_port           = local.api_port
  deletion_protection   = var.deletion_protection
  access_logs_enabled   = var.access_log_retention_enabled
  access_logs_bucket    = var.access_log_retention_enabled ? module.access_logs[0].bucket_name : ""
  access_logs_prefix    = "alb"
}

# --- Mídia, filas e MediaConvert (7.3 e 7.4) ---

module "media" {
  source = "../../modules/media"

  providers = {
    aws           = aws
    aws.us_east_1 = aws.us_east_1
  }

  name                  = local.name
  bucket_name           = "${local.name}-media-${var.aws_account_id}"
  domain_name           = local.media_domain
  validate_with_route53 = local.use_route53
  route53_zone_id       = local.route53_zone_id
  public_keys           = var.cloudfront_public_keys
}

module "queues" {
  source = "../../modules/queues"

  name = local.name
  queues = {
    media-jobs = {
      visibility_timeout_seconds = 120
    }
    video-events = {
      visibility_timeout_seconds = 60
      allowed_source_rule_arns   = [local.video_events_rule_arn]
    }
    push = {
      visibility_timeout_seconds = 60
    }
  }
}

module "mediaconvert" {
  source = "../../modules/mediaconvert"

  name                   = local.name
  bucket_arn             = module.media.bucket_arn
  video_events_queue_arn = module.queues.queue_arns["video-events"]
  rule_name              = local.video_events_rule_name
}

# --- Banco e cache (7.2) ---

module "rds" {
  source = "../../modules/rds"

  name                 = local.name
  private_subnet_ids   = module.network.private_subnet_ids
  security_group_id    = module.network.security_group_ids["rds"]
  instance_class       = local.porte.rds_instance_class
  multi_az             = local.porte.rds_multi_az
  db_name              = local.db_name
  master_username      = local.db_master_user
  deletion_protection  = var.deletion_protection
  performance_insights = var.rds_performance_insights
}

resource "random_password" "valkey_auth" {
  length  = 64
  special = false
}

module "elasticache" {
  source = "../../modules/elasticache"

  name               = "${local.name}-valkey"
  private_subnet_ids = module.network.private_subnet_ids
  security_group_id  = module.network.security_group_ids["valkey"]
  node_type          = local.porte.valkey_node_type
  auth_token         = random_password.valkey_auth.result
}

# --- Segredos (7.5) ---

resource "random_password" "db_app" {
  length  = 40
  special = false
}

resource "random_password" "db_migrator" {
  length  = 40
  special = false
}

locals {
  # O certificado do RDS é verificado (verify-full): a imagem traz o bundle de CAs do RDS em
  # NODE_EXTRA_CA_CERTS (Dockerfiles da API e do worker).
  db_host_port_name = "${module.rds.address}:${module.rds.port}/${module.rds.db_name}"

  generated_secret_names = toset(["database-url", "database-url-migrator", "database-app-password", "database-migrator-password", "redis-url"])
  generated_secret_values = {
    "database-url"               = "postgres://${local.db_app_role}:${random_password.db_app.result}@${local.db_host_port_name}?sslmode=verify-full"
    "database-url-migrator"      = "postgres://${local.db_migrator_role}:${random_password.db_migrator.result}@${local.db_host_port_name}?sslmode=verify-full"
    "database-app-password"      = random_password.db_app.result
    "database-migrator-password" = random_password.db_migrator.result
    "redis-url"                  = "rediss://:${random_password.valkey_auth.result}@${module.elasticache.primary_endpoint_address}:${module.elasticache.port}"
  }

  # O jwt-access-previous-secret existe sempre (vazio fora da rotação) e só é injetado com
  # jwt_previous_enabled: apagar e recriar um segredo no Secrets Manager esbarra na janela de
  # recuperação de 30 dias do nome.
  manual_secret_names = toset(concat(
    ["jwt-access-secret", "jwt-access-previous-secret", "cloudfront-private-key"],
    var.expo_access_token_enabled ? ["expo-access-token"] : [],
  ))
}

module "secrets" {
  source = "../../modules/secrets"

  backend          = local.secrets_backend
  name_prefix      = "${var.project}/${var.environment}"
  generated_names  = local.generated_secret_names
  generated_values = local.generated_secret_values
  manual_names     = local.manual_secret_names
}

# --- E-mail e DNS ---

module "ses" {
  source = "../../modules/ses"

  domain_name = var.domain_name
}

module "dns" {
  source = "../../modules/dns"
  count  = local.use_route53 ? 1 : 0

  zone_id                = local.route53_zone_id
  api_domain             = local.api_domain
  alb_dns_name           = module.alb.dns_name
  alb_zone_id            = module.alb.zone_id
  media_domain           = local.media_domain
  cloudfront_domain_name = module.media.distribution_domain_name
  cloudfront_zone_id     = module.media.distribution_hosted_zone_id
  ses_domain             = var.domain_name
  dkim_tokens            = module.ses.dkim_tokens
}

# --- IAM (7.5) ---

module "iam" {
  source = "../../modules/iam"

  name                   = local.name
  aws_account_id         = var.aws_account_id
  region                 = var.region
  media_bucket_arn       = module.media.bucket_arn
  api_queue_arns         = [module.queues.queue_arns["media-jobs"], module.queues.queue_arns["push"]]
  worker_queue_arns      = [module.queues.queue_arns["media-jobs"], module.queues.queue_arns["video-events"], module.queues.queue_arns["push"]]
  mediaconvert_role_arn  = module.mediaconvert.role_arn
  mediaconvert_queue_arn = local.mediaconvert_queue_arn

  github_repository          = var.github_repository
  github_oidc_provider_arn   = var.github_repository == "" ? "" : data.aws_iam_openid_connect_provider.github[0].arn
  ecr_repository_arns        = values(module.ecr.repository_arns)
  ecs_cluster_name           = module.ecs_cluster.name
  deploy_service_names       = [local.api_service_name, local.worker_service_name]
  deploy_task_families       = [local.migrate_family]
  deploy_execution_role_arns = [module.api.execution_role_arn, module.worker.execution_role_arn, module.migrate.execution_role_arn]
}

# --- Serviços (7.1) e tasks avulsas ---

locals {
  api_service_name    = "${local.name}-api"
  worker_service_name = "${local.name}-worker"
  migrate_family      = "${local.name}-migrate"

  # Só o que difere do padrão do código (env.schema.ts) ou é obrigatório em produção. Mapa completo
  # das variáveis e de onde cada uma vem: docs/deploy/variaveis.md.
  common_environment = {
    NODE_ENV                  = "production"
    LOG_LEVEL                 = "info"
    AWS_REGION                = var.region
    S3_BUCKET_MEDIA           = module.media.bucket_name
    SQS_QUEUE_MEDIA_JOBS      = module.queues.queue_names["media-jobs"]
    SQS_QUEUE_PUSH            = module.queues.queue_names["push"]
    SENTRY_ENVIRONMENT        = "production"
    SENTRY_TRACES_SAMPLE_RATE = tostring(var.sentry_traces_sample_rate)
    OTEL_ENABLED              = "false"
  }

  api_environment = merge(
    local.common_environment,
    {
      API_HOST               = "0.0.0.0"
      API_PORT               = tostring(local.api_port)
      TRUST_PROXY_HOPS       = "1"
      PROXIMITY_STORE        = "redis"
      MEDIA_URL_SIGNER       = "cloudfront"
      CLOUDFRONT_DOMAIN      = local.media_domain
      CLOUDFRONT_KEY_PAIR_ID = module.media.public_key_ids[var.cloudfront_active_key]
      EMAIL_SENDER           = "ses"
      EMAIL_FROM             = local.email_from
      EMAIL_LINK_BASE_URL    = var.email_link_base_url
      MODERATION_EMAIL       = var.moderation_email
      JWT_ACCESS_KID         = var.jwt_access_kid
      SENTRY_RELEASE         = "sussurro-api@${var.image_tag}"
    },
    var.sentry_dsn_api == "" ? {} : { SENTRY_DSN = var.sentry_dsn_api },
    var.jwt_previous_enabled ? { JWT_ACCESS_PREVIOUS_KID = var.jwt_previous_kid } : {},
  )

  worker_environment = merge(
    local.common_environment,
    {
      SQS_QUEUE_VIDEO_EVENTS = module.queues.queue_names["video-events"]
      VIDEO_PROCESSOR        = "mediaconvert"
      MEDIACONVERT_ROLE_ARN  = module.mediaconvert.role_arn
      PUSH_SENDER            = "expo"
      SENTRY_RELEASE         = "sussurro-worker@${var.image_tag}"
    },
    var.mediaconvert_queue_arn == "" ? {} : { MEDIACONVERT_QUEUE_ARN = var.mediaconvert_queue_arn },
    var.sentry_dsn_worker == "" ? {} : { SENTRY_DSN = var.sentry_dsn_worker },
  )

  db_secrets = {
    DATABASE_URL = module.secrets.refs["database-url"]
    REDIS_URL    = module.secrets.refs["redis-url"]
  }

  api_secrets = merge(
    local.db_secrets,
    {
      JWT_ACCESS_SECRET      = module.secrets.refs["jwt-access-secret"]
      CLOUDFRONT_PRIVATE_KEY = module.secrets.refs["cloudfront-private-key"]
    },
    var.jwt_previous_enabled ? { JWT_ACCESS_PREVIOUS_SECRET = module.secrets.refs["jwt-access-previous-secret"] } : {},
  )

  worker_secrets = merge(
    local.db_secrets,
    var.expo_access_token_enabled ? { EXPO_ACCESS_TOKEN = module.secrets.refs["expo-access-token"] } : {},
  )

  # Cria (ou atualiza) os usuários do banco: sussurro_migrator (dono do schema, roda as migrations)
  # e sussurro_app (só SELECT, INSERT, UPDATE e DELETE; usado pela API e pelo worker). Idempotente:
  # rodar de novo só reaplica senhas e permissões (rotação, runbook). As senhas vêm do ambiente
  # (\getenv), nunca da linha de comando.
  db_bootstrap_script = <<-EOT
    set -eu
    psql -X -v ON_ERROR_STOP=1 <<'SQL'
    \getenv migrator_password MIGRATOR_DB_PASSWORD
    \getenv app_password APP_DB_PASSWORD
    SELECT 'CREATE ROLE ${local.db_migrator_role} LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${local.db_migrator_role}') \gexec
    SELECT 'CREATE ROLE ${local.db_app_role} LOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${local.db_app_role}') \gexec
    ALTER ROLE ${local.db_migrator_role} WITH LOGIN PASSWORD :'migrator_password';
    ALTER ROLE ${local.db_app_role} WITH LOGIN PASSWORD :'app_password';
    GRANT ${local.db_migrator_role} TO CURRENT_USER;
    GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${local.db_name} TO ${local.db_migrator_role};
    GRANT CONNECT ON DATABASE ${local.db_name} TO ${local.db_app_role};
    GRANT USAGE, CREATE ON SCHEMA public TO ${local.db_migrator_role};
    GRANT USAGE ON SCHEMA public TO ${local.db_app_role};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${local.db_migrator_role} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${local.db_app_role};
    ALTER DEFAULT PRIVILEGES FOR ROLE ${local.db_migrator_role} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${local.db_app_role};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${local.db_app_role};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${local.db_app_role};
    SQL
    echo "db-bootstrap: usuarios ${local.db_migrator_role} e ${local.db_app_role} prontos"
  EOT
}

module "api" {
  source = "../../modules/ecs-service"

  name                 = local.api_service_name
  cluster_arn          = module.ecs_cluster.arn
  cluster_name         = module.ecs_cluster.name
  create_service       = var.services_enabled
  image                = local.api_image
  cpu                  = local.porte.task_cpu
  memory               = local.porte.task_memory
  environment          = local.api_environment
  secrets              = local.api_secrets
  container_port       = local.api_port
  attach_load_balancer = true
  target_group_arn     = module.alb.target_group_arn
  subnet_ids           = module.network.public_subnet_ids
  security_group_ids   = [module.network.security_group_ids["api"]]
  desired_count        = local.porte.api_desired_count
  capacity_provider    = "FARGATE"
  task_role_arn        = module.iam.api_task_role_arn
  ecr_repository_arns  = [module.ecr.repository_arns["api"]]
  log_retention_days   = var.log_retention_days
  log_group_class      = local.log_group_class

  autoscaling = {
    min        = local.porte.api_min
    max        = local.porte.api_max
    cpu_target = local.porte.api_autoscaling_cpu_percent
  }
}

module "worker" {
  source = "../../modules/ecs-service"

  name                = local.worker_service_name
  cluster_arn         = module.ecs_cluster.arn
  cluster_name        = module.ecs_cluster.name
  create_service      = var.services_enabled
  image               = local.worker_image
  cpu                 = local.porte.task_cpu
  memory              = local.porte.task_memory
  environment         = local.worker_environment
  secrets             = local.worker_secrets
  subnet_ids          = module.network.public_subnet_ids
  security_group_ids  = [module.network.security_group_ids["worker"]]
  desired_count       = 1
  capacity_provider   = local.porte.worker_capacity_provider
  task_role_arn       = module.iam.worker_task_role_arn
  ecr_repository_arns = [module.ecr.repository_arns["worker"]]
  log_retention_days  = var.log_retention_days
  log_group_class     = local.log_group_class

  # Dá tempo de devolver as mensagens em andamento à fila (o Spot avisa 2 min antes).
  stop_timeout = 120
}

# Migration (infra.md §6.6): a mesma imagem da API com `node dist/migrate.js`, como o usuário
# sussurro_migrator. Roda avulsa (run-task) antes de trocar a revisão dos serviços.
module "migrate" {
  source = "../../modules/ecs-service"

  name                = local.migrate_family
  cluster_arn         = module.ecs_cluster.arn
  cluster_name        = module.ecs_cluster.name
  create_service      = false
  image               = local.api_image
  command             = ["node", "dist/migrate.js"]
  cpu                 = local.porte.one_off_task_cpu
  memory              = local.porte.one_off_task_memory
  subnet_ids          = module.network.public_subnet_ids
  security_group_ids  = [module.network.security_group_ids["ops"]]
  ecr_repository_arns = [module.ecr.repository_arns["api"]]
  log_retention_days  = var.log_retention_days
  log_group_class     = local.log_group_class

  environment = {
    NODE_ENV = "production"
  }

  secrets = {
    DATABASE_URL = module.secrets.refs["database-url-migrator"]
  }
}

# Cria os usuários do banco (primeiro deploy e rotação de senha). TLS sem verificação do certificado
# (sslmode=require): a imagem oficial do PostgreSQL não traz o bundle de CAs do RDS, e a conexão não
# sai da VPC (security group ops → rds).
module "db_bootstrap" {
  source = "../../modules/ecs-service"

  name               = "${local.name}-db-bootstrap"
  cluster_arn        = module.ecs_cluster.arn
  cluster_name       = module.ecs_cluster.name
  create_service     = false
  image              = local.postgres_image
  user               = "postgres"
  entry_point        = ["/bin/sh", "-c"]
  command            = [local.db_bootstrap_script]
  cpu                = local.porte.one_off_task_cpu
  memory             = local.porte.one_off_task_memory
  subnet_ids         = module.network.public_subnet_ids
  security_group_ids = [module.network.security_group_ids["ops"]]
  log_retention_days = var.log_retention_days
  log_group_class    = local.log_group_class

  environment = {
    PGHOST     = module.rds.address
    PGPORT     = tostring(module.rds.port)
    PGDATABASE = local.db_name
    PGSSLMODE  = "require"
    PGAPPNAME  = "sussurro-db-bootstrap"
  }

  secrets = {
    PGUSER               = { kind = "secretsmanager", arn = module.rds.master_user_secret_arn, json_key = "username" }
    PGPASSWORD           = { kind = "secretsmanager", arn = module.rds.master_user_secret_arn, json_key = "password" }
    APP_DB_PASSWORD      = module.secrets.refs["database-app-password"]
    MIGRATOR_DB_PASSWORD = module.secrets.refs["database-migrator-password"]
  }
}

# --- Alarmes (infra.md §7) ---

module "observability" {
  source = "../../modules/observability"

  name                                = local.name
  alarm_email                         = var.alarm_email
  alb_arn_suffix                      = module.alb.arn_suffix
  target_group_arn_suffix             = module.alb.target_group_arn_suffix
  ecs_cluster_name                    = module.ecs_cluster.name
  rds_identifier                      = module.rds.identifier
  rds_freeable_memory_threshold_bytes = local.porte.rds_freeable_memory_alarm
  rds_connections_threshold           = floor(local.porte.rds_max_connections * 0.8)
  valkey_cache_cluster_id             = module.elasticache.cache_cluster_id
  dlq_names                           = module.queues.dlq_names
  mediaconvert_queue_arn              = local.mediaconvert_queue_arn

  ecs_service_names = {
    api    = local.api_service_name
    worker = local.worker_service_name
  }

  age_alarm_queue_names = {
    media-jobs = module.queues.queue_names["media-jobs"]
    push       = module.queues.queue_names["push"]
  }
}
