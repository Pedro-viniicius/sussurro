# RDS PostgreSQL 18 (infra.md §6.4, backlog 7.2): gp3 criptografado, rds.force_ssl = 1, backups de
# 14 dias com PITR, deletion protection, sem acesso público e senha mestre gerenciada pelo RDS no
# Secrets Manager. A aplicação usa um usuário sem DDL e a migration um usuário próprio (criados pela
# task db-bootstrap; runbook).

resource "aws_db_subnet_group" "this" {
  name        = var.name
  description = "Subnets privadas isoladas do ${var.name}"
  subnet_ids  = var.private_subnet_ids
}

resource "aws_db_parameter_group" "this" {
  name        = "${var.name}-pg18"
  family      = "postgres18"
  description = "Parametros do ${var.name}: TLS obrigatorio"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_db_instance" "this" {
  identifier     = var.name
  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class
  multi_az       = var.multi_az

  db_name                     = var.db_name
  username                    = var.master_username
  manage_master_user_password = true
  port                        = 5432

  storage_type          = "gp3"
  allocated_storage     = var.allocated_storage
  max_allocated_storage = var.max_allocated_storage
  storage_encrypted     = true

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [var.security_group_id]
  publicly_accessible    = false
  network_type           = "IPV4"
  parameter_group_name   = aws_db_parameter_group.this.name
  ca_cert_identifier     = "rds-ca-rsa2048-g1"

  backup_retention_period   = var.backup_retention_days
  backup_window             = "06:00-07:00"
  maintenance_window        = "sun:07:30-sun:08:30"
  copy_tags_to_snapshot     = true
  delete_automated_backups  = true
  deletion_protection       = var.deletion_protection
  skip_final_snapshot       = false
  final_snapshot_identifier = "${var.name}-final"

  auto_minor_version_upgrade  = true
  allow_major_version_upgrade = false
  apply_immediately           = false

  iam_database_authentication_enabled = false
  performance_insights_enabled        = var.performance_insights
  monitoring_interval                 = 0
}
