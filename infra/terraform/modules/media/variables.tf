variable "name" {
  description = "Prefixo dos nomes (ex.: sussurro-prod)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "Use letras minúsculas, números e hífen."
  }
}

variable "bucket_name" {
  description = "Nome do bucket de mídia (único no mundo; o padrão inclui o id da conta)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "Nome de bucket inválido (3 a 63 caracteres, minúsculas, números, ponto e hífen)."
  }
}

variable "domain_name" {
  description = "Nome da mídia no CloudFront (ex.: media.example.com), com certificado ACM em us-east-1."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.domain_name))
    error_message = "Informe um nome de domínio válido, em minúsculas."
  }
}

variable "validate_with_route53" {
  description = "true = cria os registros de validação do ACM no Route 53; false = DNS externo (registros à mão)."
  type        = bool
}

variable "route53_zone_id" {
  description = "Zona do Route 53 (só com validate_with_route53 = true)."
  type        = string
  default     = null
}

variable "public_keys" {
  description = "Chaves públicas RSA (PEM) do trusted key group, por apelido (ex.: k1). Rotação: inclua a nova, troque a ativa e depois tire a antiga."
  type        = map(string)

  validation {
    condition     = length(var.public_keys) >= 1 && length(var.public_keys) <= 5 && alltrue([for k, v in var.public_keys : can(regex("^[a-z0-9-]+$", k)) && strcontains(v, "BEGIN PUBLIC KEY")])
    error_message = "Informe de 1 a 5 chaves públicas em PEM (BEGIN PUBLIC KEY), com apelidos em minúsculas."
  }
}

variable "incoming_expiration_days" {
  description = "Dias até os uploads em incoming/ expirarem (ADR 0009 e backlog 7.3: 1 dia)."
  type        = number
  default     = 1

  validation {
    condition     = var.incoming_expiration_days >= 1 && var.incoming_expiration_days <= 7
    error_message = "Use de 1 a 7 dias."
  }
}

variable "noncurrent_version_expiration_days" {
  description = "Dias até as versões antigas (sobrescritas ou apagadas) sumirem (infra.md §6.4: 7)."
  type        = number
  default     = 7

  validation {
    condition     = var.noncurrent_version_expiration_days >= 1 && var.noncurrent_version_expiration_days <= 30
    error_message = "Use de 1 a 30 dias."
  }
}

variable "price_class" {
  description = "Classe de preço do CloudFront. A América do Sul só entra na PriceClass_All."
  type        = string
  default     = "PriceClass_All"

  validation {
    condition     = contains(["PriceClass_All", "PriceClass_200", "PriceClass_100"], var.price_class)
    error_message = "Use PriceClass_All, PriceClass_200 ou PriceClass_100."
  }
}
