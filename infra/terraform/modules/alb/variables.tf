variable "name" {
  description = "Prefixo dos nomes (ex.: sussurro-prod). O ALB e o target group têm até 32 caracteres."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name))
    error_message = "Use letras minúsculas, números e hífen (até 25 caracteres)."
  }
}

variable "vpc_id" {
  description = "VPC do target group."
  type        = string
}

variable "public_subnet_ids" {
  description = "Subnets públicas do ALB (duas AZs)."
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group do ALB."
  type        = string
}

variable "domain_name" {
  description = "Nome da API (ex.: api.example.com): certificado ACM e registro DNS."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.domain_name))
    error_message = "Informe um nome de domínio válido, em minúsculas."
  }
}

variable "validate_with_route53" {
  description = "true = cria os registros de validação do ACM na zona do Route 53; false = o DNS é externo e os registros são criados à mão (saída certificate_validation_records)."
  type        = bool
}

variable "route53_zone_id" {
  description = "Zona do Route 53 (só com validate_with_route53 = true)."
  type        = string
  default     = null
}

variable "target_port" {
  description = "Porta da API dentro da task."
  type        = number
}

variable "health_check_path" {
  description = "Health check do target group (infra.md §6.4: /health/ready)."
  type        = string
  default     = "/health/ready"
}

variable "deletion_protection" {
  description = "Impede apagar o ALB por engano (desligue só para destruir o ambiente)."
  type        = bool
  default     = true
}

variable "access_logs_enabled" {
  description = "Liga os logs de acesso do ALB (guarda de registros do Marco Civil, L3: desligada até o PO confirmar)."
  type        = bool
  default     = false
}

variable "access_logs_bucket" {
  description = "Bucket dos logs de acesso (módulo access-logs), quando access_logs_enabled = true."
  type        = string
  default     = ""
}

variable "access_logs_prefix" {
  description = "Prefixo dos logs de acesso no bucket."
  type        = string
  default     = "alb"
}
