variable "name" {
  description = "Prefixo dos nomes das roles (ex.: sussurro-prod)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "Use letras minúsculas, números e hífen."
  }
}

variable "aws_account_id" {
  description = "Conta da AWS (montagem dos ARNs)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Informe os 12 dígitos da conta."
  }
}

variable "region" {
  description = "Região dos recursos (montagem dos ARNs)."
  type        = string
}

variable "media_bucket_arn" {
  description = "Bucket de mídia."
  type        = string
}

variable "api_queue_arns" {
  description = "Filas em que a API envia mensagens (media-jobs e push)."
  type        = list(string)
}

variable "worker_queue_arns" {
  description = "Filas que o worker consome (media-jobs, video-events e push)."
  type        = list(string)
}

variable "mediaconvert_role_arn" {
  description = "Role de serviço do MediaConvert (o worker só pode passar esta)."
  type        = string
}

variable "mediaconvert_queue_arn" {
  description = "Fila do MediaConvert em que o worker cria jobs (a Default, se nenhuma for escolhida)."
  type        = string
}

variable "github_repository" {
  description = "Repositório do GitHub (dono/nome) autorizado a fazer deploy via OIDC. Vazio = sem role de deploy."
  type        = string
  default     = ""

  validation {
    condition     = var.github_repository == "" || can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "Use o formato dono/nome (ou deixe vazio)."
  }
}

variable "github_oidc_provider_arn" {
  description = "Provedor OIDC do GitHub criado pelo bootstrap (só com github_repository)."
  type        = string
  default     = ""
}

variable "ecr_repository_arns" {
  description = "Repositórios em que o deploy publica imagens."
  type        = list(string)
  default     = []
}

variable "ecs_cluster_name" {
  description = "Cluster em que o deploy atualiza serviços e roda a migration."
  type        = string
}

variable "deploy_service_names" {
  description = "Serviços que o deploy pode atualizar (api e worker)."
  type        = list(string)
  default     = []
}

variable "deploy_task_families" {
  description = "Famílias de task definition que o deploy pode rodar avulsas (a migration)."
  type        = list(string)
  default     = []
}

variable "deploy_execution_role_arns" {
  description = "Execution roles que o deploy pode passar ao ECS ao registrar revisões (as task roles deste módulo entram sozinhas)."
  type        = list(string)
  default     = []
}
