output "api_task_role_arn" {
  description = "Task role da API."
  value       = aws_iam_role.api.arn
}

output "worker_task_role_arn" {
  description = "Task role do worker."
  value       = aws_iam_role.worker.arn
}

output "deploy_role_arn" {
  description = "Role de deploy do GitHub Actions (null sem github_repository)."
  value       = one(aws_iam_role.deploy[*].arn)
}
