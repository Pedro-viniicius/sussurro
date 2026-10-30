variable "name" {
  description = "Prefixo dos nomes (ex.: sussurro-prod)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "Use letras minúsculas, números e hífen."
  }
}

variable "bucket_arn" {
  description = "Bucket de mídia: o MediaConvert lê incoming/* e grava media/*."
  type        = string
}

variable "video_events_queue_arn" {
  description = "Fila video-events, alvo da regra do EventBridge."
  type        = string
}

variable "rule_name" {
  description = "Nome da regra do EventBridge (o mesmo usado na política da fila video-events)."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]{1,64}$", var.rule_name))
    error_message = "Use até 64 caracteres: letras, números, ponto, hífen e sublinhado."
  }
}

variable "app_metadata" {
  description = "Valor de userMetadata.app nos jobs do worker (ADR 0006): eventos de outros apps são ignorados."
  type        = string
  default     = "sussurro"
}
