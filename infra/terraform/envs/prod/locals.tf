locals {
  name = "${var.project}-${var.environment}"

  tags = {
    Project     = var.project
    Environment = var.environment
    Porte       = var.porte
    ManagedBy   = "terraform"
  }

  # P5/D12: uma variável escolhe o porte (infra.md §9 e §9.1). Os números de conexões e de memória
  # livre do RDS são estimativas da classe, só para os alarmes.
  portes = {
    enxuto = {
      rds_instance_class          = "db.t4g.micro"
      rds_multi_az                = false
      rds_max_connections         = 85
      rds_freeable_memory_alarm   = 67108864
      api_desired_count           = 1
      api_min                     = 1
      api_max                     = 3
      worker_capacity_provider    = "FARGATE_SPOT"
      secrets_backend             = "ssm"
      log_group_class             = "INFREQUENT_ACCESS"
      valkey_node_type            = "cache.t4g.micro"
      task_cpu                    = 512
      task_memory                 = 1024
      one_off_task_cpu            = 256
      one_off_task_memory         = 512
      api_autoscaling_cpu_percent = 60
    }
    completo = {
      rds_instance_class          = "db.t4g.small"
      rds_multi_az                = true
      rds_max_connections         = 180
      rds_freeable_memory_alarm   = 134217728
      api_desired_count           = 2
      api_min                     = 2
      api_max                     = 4
      worker_capacity_provider    = "FARGATE"
      secrets_backend             = "secretsmanager"
      log_group_class             = "STANDARD"
      valkey_node_type            = "cache.t4g.micro"
      task_cpu                    = 512
      task_memory                 = 1024
      one_off_task_cpu            = 256
      one_off_task_memory         = 512
      api_autoscaling_cpu_percent = 60
    }
  }

  porte           = local.portes[var.porte]
  secrets_backend = coalesce(var.secrets_backend, local.porte.secrets_backend)
  log_group_class = coalesce(var.log_group_class, local.porte.log_group_class)

  use_route53     = var.dns_mode == "route53"
  route53_zone_id = local.use_route53 ? data.aws_route53_zone.this[0].zone_id : null
  api_domain      = "api.${var.domain_name}"
  media_domain    = "media.${var.domain_name}"
  email_from      = var.email_from != "" ? var.email_from : "Sussurro <nao-responda@${var.domain_name}>"

  api_port = 3000

  # Banco: o usuário mestre (senha gerenciada pelo RDS) só cria os outros dois na task db-bootstrap.
  db_name          = "sussurro"
  db_master_user   = "sussurro_admin"
  db_migrator_role = "sussurro_migrator"
  db_app_role      = "sussurro_app"

  # A regra do EventBridge tem nome fixo para a política da video-events conhecer o ARN dela antes
  # de ela existir (sem ciclo entre a fila e a regra).
  video_events_rule_name = "${local.name}-mediaconvert-job-state"
  video_events_rule_arn  = "arn:aws:events:${var.region}:${var.aws_account_id}:rule/${local.video_events_rule_name}"
  mediaconvert_queue_arn = var.mediaconvert_queue_arn != "" ? var.mediaconvert_queue_arn : "arn:aws:mediaconvert:${var.region}:${var.aws_account_id}:queues/Default"

  api_image    = "${module.ecr.repository_urls["api"]}:${var.image_tag}"
  worker_image = "${module.ecr.repository_urls["worker"]}:${var.image_tag}"

  # Imagem oficial do PostgreSQL (a mesma tag do docker-compose e do CI), fixada por digest: a task
  # db-bootstrap roda o psql com a senha mestre.
  postgres_image = "docker.io/library/postgres:18.6-bookworm@sha256:5c4783a8cc3f0074912164f94dfa1be4e043438f0f707cf968d7af9a0d31a2c8"
}
