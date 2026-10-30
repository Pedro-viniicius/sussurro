variable "name" {
  description = "Prefixo dos nomes dos alarmes e do tópico (ex.: sussurro-prod)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "Use letras minúsculas, números e hífen."
  }
}

variable "alarm_email" {
  description = "E-mail que recebe os alarmes (a inscrição no SNS precisa ser confirmada pelo link que chega)."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "Informe um e-mail válido."
  }
}

variable "alb_arn_suffix" {
  description = "Dimensão LoadBalancer do ALB."
  type        = string
}

variable "target_group_arn_suffix" {
  description = "Dimensão TargetGroup do target group da API."
  type        = string
}

variable "ecs_cluster_name" {
  description = "Cluster ECS."
  type        = string
}

variable "ecs_service_names" {
  description = "Serviços com alarme de CPU e memória, por apelido (api e worker)."
  type        = map(string)
}

variable "rds_identifier" {
  description = "Instância do RDS."
  type        = string
}

variable "rds_free_storage_threshold_bytes" {
  description = "Alarme quando o disco livre do RDS cai abaixo disto (20% dos 20 GB iniciais = 4 GiB)."
  type        = number
  default     = 4294967296
}

variable "rds_freeable_memory_threshold_bytes" {
  description = "Alarme quando a memória livre do RDS cai abaixo disto (depende da classe)."
  type        = number
}

variable "rds_connections_threshold" {
  description = "Alarme acima deste número de conexões (80% do máximo estimado da classe)."
  type        = number
}

variable "valkey_cache_cluster_id" {
  description = "Nó do Valkey (dimensão CacheClusterId)."
  type        = string
}

variable "dlq_names" {
  description = "DLQs com alarme de qualquer mensagem visível, por apelido."
  type        = map(string)
}

variable "age_alarm_queue_names" {
  description = "Filas com alarme de mensagem parada há mais de 5 min (worker parado), por apelido."
  type        = map(string)
}

variable "mediaconvert_queue_arn" {
  description = "Fila do MediaConvert (dimensão Queue da métrica JobsErroredCount)."
  type        = string
}
