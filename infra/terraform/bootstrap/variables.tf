variable "region" {
  description = "Região principal (D12: sa-east-1, a confirmar pelo PO)."
  type        = string
  default     = "sa-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.region))
    error_message = "Informe uma região da AWS (ex.: sa-east-1)."
  }
}

variable "aws_account_id" {
  description = "Conta da AWS em que o bootstrap pode ser aplicado (o provider recusa qualquer outra)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Informe os 12 dígitos da conta."
  }
}

variable "project" {
  description = "Nome do projeto (prefixo dos recursos)."
  type        = string
  default     = "sussurro"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,20}$", var.project))
    error_message = "Use letras minúsculas, números e hífen."
  }
}

variable "cost_alert_email" {
  description = "E-mail que recebe os alertas de orçamento e de anomalia de custo."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.cost_alert_email))
    error_message = "Informe um e-mail válido."
  }
}

variable "monthly_budget_usd" {
  description = "Orçamento mensal da conta em USD (P7: 200 no porte enxuto, 350 no completo)."
  type        = number
  default     = 200

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "Informe um valor positivo."
  }
}

variable "media_budget_usd" {
  description = "Orçamento mensal só de MediaConvert + CloudFront em USD (lançamento: ~US$ 20 com o plano flat-rate Pro)."
  type        = number
  default     = 40

  validation {
    condition     = var.media_budget_usd > 0
    error_message = "Informe um valor positivo."
  }
}

variable "anomaly_monitor_arn" {
  description = "Monitor de anomalias de custo que já existe na conta (veja no console do Cost Anomaly Detection). Vazio = cria um."
  type        = string
  default     = ""
}

variable "create_dns_zone" {
  description = "Cria a zona do Route 53 do domínio (recomendado: o envs/prod com dns_mode = route53 cria sozinho os registros e as validações). false = DNS fora da AWS."
  type        = bool
  default     = true
}

variable "domain_name" {
  description = "Domínio do app (P6, decisão do PO), ex.: example.com. Obrigatório com create_dns_zone."
  type        = string
  default     = ""

  validation {
    condition     = var.domain_name == "" || can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.domain_name))
    error_message = "Informe um domínio válido, em minúsculas, ou deixe vazio."
  }

  validation {
    condition     = !var.create_dns_zone || var.domain_name != ""
    error_message = "Com create_dns_zone = true, informe o domain_name."
  }
}

variable "github_oidc_enabled" {
  description = "Cria o provedor OIDC do GitHub (o deploy pelo Actions assume uma role sem chave de longa duração)."
  type        = bool
  default     = true
}
