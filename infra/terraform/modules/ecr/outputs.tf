output "repository_urls" {
  description = "URL de cada repositório, por nome curto (ex.: api)."
  value       = { for k, r in aws_ecr_repository.this : k => r.repository_url }
}

output "repository_arns" {
  description = "ARN de cada repositório, por nome curto."
  value       = { for k, r in aws_ecr_repository.this : k => r.arn }
}
