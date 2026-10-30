output "primary_endpoint_address" {
  description = "Endereço do nó primário (host da REDIS_URL, com rediss://)."
  value       = aws_elasticache_replication_group.this.primary_endpoint_address
}

output "port" {
  description = "Porta do Valkey."
  value       = aws_elasticache_replication_group.this.port
}

output "cache_cluster_id" {
  description = "Id do nó (dimensão CacheClusterId das métricas; a AWS nomeia o primeiro nó <grupo>-001)."
  value       = "${aws_elasticache_replication_group.this.id}-001"
}
