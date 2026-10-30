output "task_definition_arn" {
  description = "ARN da revisão da task definition registrada por este apply (use no update-service ou no run-task)."
  value       = aws_ecs_task_definition.this.arn
}

output "task_definition_family" {
  description = "Família da task definition."
  value       = aws_ecs_task_definition.this.family
}

output "task_definition_revision" {
  description = "Número da revisão registrada por este apply."
  value       = aws_ecs_task_definition.this.revision
}

output "service_name" {
  description = "Nome do serviço (null quando create_service = false)."
  value       = one(aws_ecs_service.this[*].name)
}

output "log_group_name" {
  description = "Log group no CloudWatch."
  value       = aws_cloudwatch_log_group.this.name
}

output "execution_role_arn" {
  description = "ARN da execution role (o deploy precisa passá-la ao registrar uma revisão)."
  value       = aws_iam_role.execution.arn
}
