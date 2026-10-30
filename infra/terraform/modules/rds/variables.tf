variable "name" {
  description = "Identificador da instância e prefixo do subnet group e do parameter group."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,50}$", var.name))
    error_message = "Use letras minúsculas, números e hífen."
  }
}

variable "private_subnet_ids" {
  description = "Subnets privadas isoladas (sem rota para a internet)."
  type        = list(string)
}

variable "security_group_id" {
  description = "Security group do banco (entrada 5432 só da API, do worker e das tasks avulsas)."
  type        = string
}

variable "instance_class" {
  description = "Classe da instância (porte enxuto: db.t4g.micro; completo: db.t4g.small)."
  type        = string

  validation {
    condition     = can(regex("^db\\.[a-z0-9]+\\.[a-z0-9]+$", var.instance_class))
    error_message = "Informe uma classe do RDS (ex.: db.t4g.micro)."
  }
}

variable "multi_az" {
  description = "Multi-AZ (failover automático). Porte enxuto: false; completo: true (infra.md §9.1)."
  type        = bool
}

variable "engine_version" {
  description = "Versão do PostgreSQL. Só a major (18): as minors entram na janela de manutenção."
  type        = string
  default     = "18"

  validation {
    condition     = can(regex("^18(\\.[0-9]+)?$", var.engine_version))
    error_message = "A arquitetura usa o PostgreSQL 18."
  }
}

variable "allocated_storage" {
  description = "Disco inicial em GB (gp3)."
  type        = number
  default     = 20

  validation {
    condition     = var.allocated_storage >= 20
    error_message = "O gp3 começa em 20 GB."
  }
}

variable "max_allocated_storage" {
  description = "Teto do autoscaling de disco em GB."
  type        = number
  default     = 100

  validation {
    condition     = var.max_allocated_storage >= 20
    error_message = "Use 20 GB ou mais."
  }
}

variable "db_name" {
  description = "Banco criado junto com a instância."
  type        = string
}

variable "master_username" {
  description = "Usuário mestre. A senha é gerada e guardada pelo próprio RDS no Secrets Manager (rotação automática)."
  type        = string
}

variable "backup_retention_days" {
  description = "Dias de backup automático e de PITR (infra.md §6.4: 14)."
  type        = number
  default     = 14

  validation {
    condition     = var.backup_retention_days >= 7 && var.backup_retention_days <= 35
    error_message = "Use de 7 a 35 dias."
  }
}

variable "deletion_protection" {
  description = "Impede apagar a instância por engano."
  type        = bool
  default     = true
}

variable "performance_insights" {
  description = "Liga o Performance Insights (7 dias grátis). Desligado por padrão: nem toda classe t4g aceita."
  type        = bool
  default     = false
}
