variable "bucket_name" {
  description = "Bucket dos logs de acesso do ALB (único no mundo; o padrão inclui o id da conta)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "Nome de bucket inválido."
  }
}

variable "aws_account_id" {
  description = "Conta da AWS (caminho AWSLogs/<conta>/ onde o ELB grava)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Informe os 12 dígitos da conta."
  }
}

variable "prefix" {
  description = "Prefixo dos logs no bucket (o mesmo configurado no ALB)."
  type        = string
  default     = "alb"
}

variable "retention_days" {
  description = "Dias de guarda (Marco Civil, art. 15: 6 meses; 185 dias cobrem qualquer sequência de 6 meses). Depois disso o lifecycle apaga."
  type        = number
  default     = 185

  validation {
    condition     = var.retention_days >= 184 && var.retention_days <= 400
    error_message = "Use de 184 dias (6 meses) a 400 dias."
  }
}

variable "reader_arns" {
  description = "Únicos principals (roles ou usuários) que podem ler os logs, para atender a uma ordem judicial. Vazio = só quem tiver permissão no IAM (administradores)."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for a in var.reader_arns : can(regex("^arn:aws[a-z-]*:(iam|sts)::[0-9]{12}:", a))])
    error_message = "Informe ARNs de roles ou usuários do IAM."
  }
}
