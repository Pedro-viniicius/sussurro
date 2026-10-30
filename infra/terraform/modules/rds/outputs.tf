output "address" {
  description = "Endereço do banco (host da DATABASE_URL)."
  value       = aws_db_instance.this.address
}

output "port" {
  description = "Porta do banco."
  value       = aws_db_instance.this.port
}

output "db_name" {
  description = "Nome do banco."
  value       = aws_db_instance.this.db_name
}

output "identifier" {
  description = "Identificador da instância (dimensão DBInstanceIdentifier das métricas)."
  value       = aws_db_instance.this.identifier
}

output "master_user_secret_arn" {
  description = "Segredo do usuário mestre (JSON com username e password), gerenciado e rotacionado pelo RDS."
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
}
