variable "name" {
  description = "Id do replication group (ex.: sussurro-prod-valkey; até 40 caracteres)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,39}$", var.name)) && !strcontains(var.name, "--")
    error_message = "Use letras minúsculas, números e hífen (até 40 caracteres, sem hífen duplo)."
  }
}

variable "private_subnet_ids" {
  description = "Subnets privadas isoladas."
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group do Valkey (entrada 6379 só da API e do worker)."
  type        = string
}

variable "node_type" {
  description = "Tipo do nó (infra.md §6.4: cache.t4g.micro, nó único na v1)."
  type        = string
  default     = "cache.t4g.micro"

  validation {
    condition     = startswith(var.node_type, "cache.")
    error_message = "Informe um tipo do ElastiCache (ex.: cache.t4g.micro)."
  }
}

variable "engine_version" {
  description = "Versão do Valkey (a mesma major do docker-compose: 8)."
  type        = string
  default     = "8.1"

  validation {
    condition     = can(regex("^8\\.[0-9]+$", var.engine_version))
    error_message = "Use uma versão 8.x do Valkey (ex.: 8.1)."
  }
}

variable "auth_token" {
  description = "Token AUTH do Valkey (gerado pelo Terraform; vai também para a REDIS_URL no Secrets Manager/SSM)."
  type        = string
  sensitive   = true

  validation {
    condition     = length(var.auth_token) >= 16 && length(var.auth_token) <= 128
    error_message = "O token AUTH tem de 16 a 128 caracteres."
  }
}
