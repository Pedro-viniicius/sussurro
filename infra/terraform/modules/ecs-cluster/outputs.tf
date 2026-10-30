output "arn" {
  description = "ARN do cluster (só fica pronto depois dos capacity providers, para os serviços nascerem depois deles)."
  value       = aws_ecs_cluster.this.arn

  depends_on = [aws_ecs_cluster_capacity_providers.this]
}

output "name" {
  description = "Nome do cluster."
  value       = aws_ecs_cluster_capacity_providers.this.cluster_name
}
