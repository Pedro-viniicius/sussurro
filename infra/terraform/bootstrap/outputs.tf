output "state_bucket_name" {
  description = "Bucket do state remoto (vai no backend.hcl do envs/prod e no backend.tf deste bootstrap)."
  value       = aws_s3_bucket.state.bucket
}

output "github_oidc_provider_arn" {
  description = "Provedor OIDC do GitHub (null se github_oidc_enabled = false)."
  value       = one(aws_iam_openid_connect_provider.github[*].arn)
}

output "route53_name_servers" {
  description = "Servidores de nome da zona: configure-os no registrador do domínio (ex.: registro.br) antes do envs/prod."
  value       = one(aws_route53_zone.this[*].name_servers)
}

output "budget_names" {
  description = "Orçamentos de custo criados."
  value       = module.budgets.budget_names
}
