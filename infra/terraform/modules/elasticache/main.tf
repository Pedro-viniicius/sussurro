# ElastiCache for Valkey (infra.md §6.4, backlog 7.2): nó único na v1, TLS em trânsito obrigatório,
# criptografia em repouso e AUTH. Só dados efêmeros (tokens de proximidade, rate limit e cache de
# 60 s): sem snapshots.

resource "aws_elasticache_subnet_group" "this" {
  name        = var.name
  description = "Subnets privadas isoladas do ${var.name}"
  subnet_ids  = var.private_subnet_ids
}

resource "aws_elasticache_parameter_group" "this" {
  name        = "${var.name}-valkey8"
  family      = "valkey8"
  description = "Parametros do ${var.name} (padrao do Valkey 8)"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_elasticache_replication_group" "this" {
  replication_group_id = var.name
  description          = "Valkey do Sussurro: tokens de proximidade, rate limit e cache curto"
  engine               = "valkey"
  engine_version       = var.engine_version
  node_type            = var.node_type
  num_cache_clusters   = 1
  port                 = 6379
  parameter_group_name = aws_elasticache_parameter_group.this.name
  subnet_group_name    = aws_elasticache_subnet_group.this.name
  security_group_ids   = [var.security_group_id]

  automatic_failover_enabled = false
  multi_az_enabled           = false

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
  transit_encryption_mode    = "required"
  auth_token                 = var.auth_token
  auth_token_update_strategy = "ROTATE"

  snapshot_retention_limit   = 0
  maintenance_window         = "sun:08:30-sun:09:30"
  auto_minor_version_upgrade = true
  apply_immediately          = false
}
