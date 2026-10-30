variable "name" {
  description = "Prefixo dos nomes dos orçamentos e do monitor de anomalias."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "Use letras minúsculas, números e hífen."
  }
}

variable "email" {
  description = "E-mail que recebe os alertas de custo."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.email))
    error_message = "Informe um e-mail válido."
  }
}

variable "monthly_limit_usd" {
  description = "Orçamento mensal da conta inteira em USD (P7: 200 no porte enxuto, 350 no completo)."
  type        = number

  validation {
    condition     = var.monthly_limit_usd > 0
    error_message = "Informe um valor positivo."
  }
}

variable "media_limit_usd" {
  description = "Orçamento mensal só de MediaConvert + CloudFront em USD (abuso de vídeo, R10)."
  type        = number

  validation {
    condition     = var.media_limit_usd > 0
    error_message = "Informe um valor positivo."
  }
}

variable "anomaly_monitor_arn" {
  description = "Monitor do Cost Anomaly Detection que já existe na conta (a AWS cria um por padrão em contas novas). Vazio = o Terraform cria um."
  type        = string
  default     = ""

  validation {
    condition     = var.anomaly_monitor_arn == "" || startswith(var.anomaly_monitor_arn, "arn:aws:ce::")
    error_message = "Informe o ARN de um monitor do Cost Explorer (arn:aws:ce::...) ou deixe vazio."
  }
}

variable "anomaly_threshold_usd" {
  description = "Avisa anomalias com impacto total a partir deste valor em USD."
  type        = number
  default     = 20

  validation {
    condition     = var.anomaly_threshold_usd > 0
    error_message = "Informe um valor positivo."
  }
}
