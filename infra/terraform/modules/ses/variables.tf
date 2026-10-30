variable "domain_name" {
  description = "Domínio que envia os e-mails (identidade do SES com DKIM; o EMAIL_FROM usa este domínio)."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.domain_name))
    error_message = "Informe um nome de domínio válido, em minúsculas."
  }
}
