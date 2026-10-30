variable "name" {
  description = "Prefixo dos nomes dos recursos (ex.: sussurro-prod)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "Use de 3 a 31 caracteres: letras minúsculas, números e hífen, começando por letra."
  }
}

variable "cidr_block" {
  description = "Faixa da VPC (infra.md §6.1: 10.20.0.0/16). Cada subnet recebe um /24."
  type        = string

  validation {
    condition     = can(cidrnetmask(var.cidr_block)) && endswith(var.cidr_block, "/16")
    error_message = "Informe um bloco IPv4 /16 (ex.: 10.20.0.0/16)."
  }
}

variable "availability_zones" {
  description = "Duas zonas de disponibilidade da região (subnets públicas e privadas em cada uma)."
  type        = list(string)

  validation {
    condition     = length(var.availability_zones) == 2 && length(distinct(var.availability_zones)) == 2
    error_message = "Informe exatamente duas zonas diferentes."
  }
}

variable "api_port" {
  description = "Porta em que a API escuta dentro da task (o ALB encaminha para ela)."
  type        = number

  validation {
    condition     = var.api_port >= 1024 && var.api_port <= 65535
    error_message = "Use uma porta sem privilégio (1024 a 65535)."
  }
}
