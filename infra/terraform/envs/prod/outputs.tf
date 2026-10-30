output "api_url" {
  description = "URL pública da API (EXPO_PUBLIC_API_URL dos perfis preview e production do EAS)."
  value       = "https://${local.api_domain}"
}

output "media_domain" {
  description = "Domínio da mídia (CLOUDFRONT_DOMAIN)."
  value       = local.media_domain
}

output "ecr_repository_urls" {
  description = "Repositórios das imagens (docker push <url>:<sha>)."
  value       = module.ecr.repository_urls
}

output "ecs_cluster_name" {
  description = "Cluster ECS."
  value       = module.ecs_cluster.name
}

output "ecs_service_names" {
  description = "Serviços da API e do worker (null enquanto services_enabled = false)."
  value = {
    api    = module.api.service_name
    worker = module.worker.service_name
  }
}

output "task_definition_arns" {
  description = "Revisões registradas por este apply: a de api e worker vai no update-service; a de migrate e db_bootstrap no run-task."
  value = {
    api          = module.api.task_definition_arn
    worker       = module.worker.task_definition_arn
    migrate      = module.migrate.task_definition_arn
    db_bootstrap = module.db_bootstrap.task_definition_arn
  }
}

output "run_task_network_configuration" {
  description = "Valor de --network-configuration do aws ecs run-task (migrate e db_bootstrap)."
  value       = "awsvpcConfiguration={subnets=[${join(",", module.network.public_subnet_ids)}],securityGroups=[${module.network.security_group_ids["ops"]}],assignPublicIp=ENABLED}"
}

output "log_groups" {
  description = "Log groups no CloudWatch."
  value = {
    api          = module.api.log_group_name
    worker       = module.worker.log_group_name
    migrate      = module.migrate.log_group_name
    db_bootstrap = module.db_bootstrap.log_group_name
  }
}

output "secrets_backend" {
  description = "Onde estão os segredos: secretsmanager ou ssm."
  value       = local.secrets_backend
}

output "secret_names" {
  description = "Nome de cada segredo no Secrets Manager ou no SSM."
  value       = module.secrets.names
}

output "manual_secrets" {
  description = "Segredos que precisam de valor posto à mão antes de subir os serviços (runbook)."
  value       = module.secrets.manual_names
}

output "rds_address" {
  description = "Endereço do RDS (só acessível de dentro da VPC)."
  value       = module.rds.address
}

output "rds_master_user_secret_arn" {
  description = "Segredo do usuário mestre do RDS (gerenciado pelo RDS)."
  value       = module.rds.master_user_secret_arn
}

output "media_bucket_name" {
  description = "Bucket de mídia."
  value       = module.media.bucket_name
}

output "cloudfront_key_pair_id" {
  description = "Id da chave pública ativa (CLOUDFRONT_KEY_PAIR_ID)."
  value       = module.media.public_key_ids[var.cloudfront_active_key]
}

output "queue_names" {
  description = "Filas principais (SQS_QUEUE_*)."
  value       = module.queues.queue_names
}

output "mediaconvert_role_arn" {
  description = "Role de serviço do MediaConvert (MEDIACONVERT_ROLE_ARN)."
  value       = module.mediaconvert.role_arn
}

output "github_deploy_role_arn" {
  description = "Role que o deploy.yml assume pelo OIDC (null sem github_repository)."
  value       = module.iam.deploy_role_arn
}

output "alarm_topic_arn" {
  description = "Tópico SNS dos alarmes (confirme a inscrição do e-mail)."
  value       = module.observability.alarm_topic_arn
}

output "access_logs_bucket" {
  description = "Bucket da guarda de registros de acesso (L3); null enquanto desligada."
  value       = var.access_log_retention_enabled ? module.access_logs[0].bucket_name : null
}

output "dns_records_to_create" {
  description = "Com dns_mode = external: os registros a criar no provedor de DNS (validações do ACM, API, mídia e DKIM). Vazio com route53."
  value = local.use_route53 ? [] : concat(
    module.alb.certificate_validation_records,
    module.media.certificate_validation_records,
    [
      { name = local.api_domain, type = "CNAME", value = module.alb.dns_name },
      { name = local.media_domain, type = "CNAME", value = module.media.distribution_domain_name },
    ],
    [for t in module.ses.dkim_tokens : { name = "${t}._domainkey.${var.domain_name}", type = "CNAME", value = "${t}.dkim.amazonses.com" }],
  )
}
