output "queue_names" {
  description = "Nome de cada fila principal, por nome curto (vai para SQS_QUEUE_*)."
  value       = { for k, q in aws_sqs_queue.main : k => q.name }
}

output "queue_arns" {
  description = "ARN de cada fila principal, por nome curto."
  value       = { for k, q in aws_sqs_queue.main : k => q.arn }
}

output "dlq_names" {
  description = "Nome de cada DLQ, por nome curto da fila principal."
  value       = { for k, q in aws_sqs_queue.dlq : k => q.name }
}
