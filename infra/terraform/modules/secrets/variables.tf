variable "backend" {
  description = "Onde ficam os segredos: secretsmanager (US$ 0,40 por segredo/mês, rotação nativa) ou ssm (Parameter Store SecureString, grátis; infra.md §9.1)."
  type        = string

  validation {
    condition     = contains(["secretsmanager", "ssm"], var.backend)
    error_message = "Use secretsmanager ou ssm."
  }
}

variable "name_prefix" {
  description = "Prefixo dos nomes (ex.: sussurro/prod → sussurro/prod/jwt-access-secret no Secrets Manager e /sussurro/prod/jwt-access-secret no SSM)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9-]+(/[a-z0-9-]+)*$", var.name_prefix))
    error_message = "Use segmentos em minúsculas separados por barra, sem barra no começo nem no fim."
  }
}

variable "generated_names" {
  description = "Segredos cujo valor o Terraform gera ou monta (senhas aleatórias e URLs com elas)."
  type        = set(string)
  default     = []
}

variable "generated_values" {
  description = "Valor de cada segredo de generated_names (nunca vem de arquivo versionado)."
  type        = map(string)
  sensitive   = true
  default     = {}
}

variable "manual_names" {
  description = "Segredos criados vazios: o valor é colocado à mão (runbook), fora do Terraform e do repositório."
  type        = set(string)
  default     = []

  validation {
    condition     = alltrue([for n in var.manual_names : can(regex("^[a-z0-9-]+$", n))])
    error_message = "Nomes em minúsculas, números e hífen."
  }
}
