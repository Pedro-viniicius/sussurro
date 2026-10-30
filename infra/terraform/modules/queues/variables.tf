variable "name" {
  description = "Prefixo dos nomes das filas (ex.: sussurro-prod → sussurro-prod-media-jobs)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "Use letras minúsculas, números e hífen."
  }
}

variable "queues" {
  description = "Filas por nome curto: visibility timeout (s) e, se houver, as regras do EventBridge que são as únicas que podem enviar."
  type = map(object({
    visibility_timeout_seconds = number
    allowed_source_rule_arns   = optional(list(string), [])
  }))

  validation {
    condition     = alltrue([for k, q in var.queues : can(regex("^[a-z][a-z0-9-]{1,40}$", k)) && q.visibility_timeout_seconds >= 0 && q.visibility_timeout_seconds <= 43200])
    error_message = "Nomes curtos em minúsculas e visibility timeout de 0 a 43200 s."
  }
}

variable "max_receive_count" {
  description = "Entregas antes de a mensagem ir para a DLQ (= MEDIA_JOBS_MAX_ATTEMPTS e PUSH_JOBS_MAX_ATTEMPTS do worker)."
  type        = number
  default     = 3

  validation {
    condition     = var.max_receive_count >= 1 && var.max_receive_count <= 10
    error_message = "Use de 1 a 10."
  }
}

variable "message_retention_seconds" {
  description = "Retenção das mensagens nas filas principais (padrão do SQS: 4 dias)."
  type        = number
  default     = 345600

  validation {
    condition     = var.message_retention_seconds >= 60 && var.message_retention_seconds <= 1209600
    error_message = "Use de 60 s a 14 dias."
  }
}

variable "dlq_retention_seconds" {
  description = "Retenção nas DLQs (infra.md §6.4: 14 dias, o máximo do SQS)."
  type        = number
  default     = 1209600

  validation {
    condition     = var.dlq_retention_seconds >= 60 && var.dlq_retention_seconds <= 1209600
    error_message = "Use de 60 s a 14 dias."
  }
}

variable "receive_wait_time_seconds" {
  description = "Long polling (infra.md §6.4: 20 s)."
  type        = number
  default     = 20

  validation {
    condition     = var.receive_wait_time_seconds >= 0 && var.receive_wait_time_seconds <= 20
    error_message = "Use de 0 a 20 s."
  }
}
