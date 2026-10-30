variable "name" {
  description = "Nome da família da task definition, do serviço e do log group (ex.: sussurro-prod-api)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,45}$", var.name))
    error_message = "Use letras minúsculas, números e hífen (até 46 caracteres)."
  }
}

variable "cluster_arn" {
  description = "ARN do cluster ECS."
  type        = string
}

variable "cluster_name" {
  description = "Nome do cluster ECS (usado no id do autoscaling)."
  type        = string
}

variable "create_service" {
  description = "false = só a task definition (tasks avulsas, como a migration); true = também o serviço."
  type        = bool
  default     = true
}

variable "image" {
  description = "Imagem do container, com tag imutável (o SHA do git) ou digest."
  type        = string

  validation {
    condition     = length(var.image) > 0 && !can(regex("\\s", var.image)) && !endswith(var.image, ":latest")
    error_message = "Informe a imagem com tag fixa ou digest (nunca :latest)."
  }
}

variable "container_name" {
  description = "Nome do container dentro da task."
  type        = string
  default     = "app"
}

variable "entry_point" {
  description = "Substitui o ENTRYPOINT da imagem (null = o da imagem)."
  type        = list(string)
  default     = null
}

variable "command" {
  description = "Substitui o CMD da imagem (null = o da imagem)."
  type        = list(string)
  default     = null
}

variable "user" {
  description = "Usuário do processo no container (null = o USER da imagem)."
  type        = string
  default     = null
}

variable "cpu" {
  description = "CPU da task em unidades do Fargate (256 = 0,25 vCPU)."
  type        = number

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.cpu)
    error_message = "Use 256, 512, 1024, 2048 ou 4096."
  }
}

variable "memory" {
  description = "Memória da task em MiB (precisa combinar com a CPU no Fargate)."
  type        = number

  validation {
    condition     = var.memory >= 512 && var.memory <= 30720
    error_message = "Use de 512 a 30720 MiB."
  }
}

variable "environment" {
  description = "Variáveis de ambiente em texto claro (nunca segredos: esses vão em secrets)."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for k in keys(var.environment) : !can(regex("(?i)(password|secret|private_key|api_key|token)", k))
    ])
    error_message = "Nome de variável com cara de segredo (password, secret, token...) precisa ir em secrets."
  }
}

variable "secrets" {
  description = "Segredos injetados pelo ECS na subida: nome da variável → { kind (secretsmanager ou ssm), arn, json_key opcional }."
  type = map(object({
    kind     = string
    arn      = string
    json_key = optional(string)
  }))
  default = {}

  validation {
    condition     = alltrue([for s in values(var.secrets) : contains(["secretsmanager", "ssm"], s.kind)])
    error_message = "kind precisa ser secretsmanager ou ssm."
  }
}

variable "container_port" {
  description = "Porta exposta pelo container (null = sem porta, como o worker)."
  type        = number
  default     = null
}

variable "attach_load_balancer" {
  description = "Liga o serviço ao target group do ALB (só a API)."
  type        = bool
  default     = false
}

variable "target_group_arn" {
  description = "Target group do ALB, quando attach_load_balancer = true."
  type        = string
  default     = null
}

variable "subnet_ids" {
  description = "Subnets das tasks (públicas, com IP público: não há NAT, infra.md §6.3)."
  type        = list(string)
}

variable "security_group_ids" {
  description = "Security groups das tasks."
  type        = list(string)
}

variable "desired_count" {
  description = "Tasks na criação do serviço (depois, o autoscaling manda; o Terraform ignora mudanças)."
  type        = number
  default     = 1

  validation {
    condition     = var.desired_count >= 0 && var.desired_count <= 10
    error_message = "Use de 0 a 10 tasks."
  }
}

variable "capacity_provider" {
  description = "FARGATE ou FARGATE_SPOT (o Spot pode ser interrompido com 2 min de aviso)."
  type        = string
  default     = "FARGATE"

  validation {
    condition     = contains(["FARGATE", "FARGATE_SPOT"], var.capacity_provider)
    error_message = "Use FARGATE ou FARGATE_SPOT."
  }
}

variable "autoscaling" {
  description = "Autoscaling por CPU: { min, max, cpu_target }. null = quantidade fixa."
  type = object({
    min        = number
    max        = number
    cpu_target = number
  })
  default = null

  validation {
    condition     = var.autoscaling == null ? true : (var.autoscaling.min >= 1 && var.autoscaling.max >= var.autoscaling.min && var.autoscaling.cpu_target > 0 && var.autoscaling.cpu_target <= 90)
    error_message = "Use min >= 1, max >= min e cpu_target entre 1 e 90."
  }
}

variable "task_role_arn" {
  description = "Role que o código da task usa para chamar a AWS (null = nenhuma permissão)."
  type        = string
  default     = null
}

variable "ecr_repository_arns" {
  description = "Repositórios ECR de onde a execution role pode baixar a imagem (vazio = imagem pública)."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "Retenção do log group no CloudWatch (infra.md §7: 30 dias)."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365], var.log_retention_days)
    error_message = "Use um valor aceito pelo CloudWatch Logs (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180 ou 365)."
  }
}

variable "log_group_class" {
  description = "Classe do log group: STANDARD ou INFREQUENT_ACCESS (mais barata, sem Live Tail nem metric filters). Trocar recria o log group."
  type        = string
  default     = "STANDARD"

  validation {
    condition     = contains(["STANDARD", "INFREQUENT_ACCESS"], var.log_group_class)
    error_message = "Use STANDARD ou INFREQUENT_ACCESS."
  }
}

variable "readonly_root_filesystem" {
  description = "Sistema de arquivos do container só de leitura (o /tmp continua gravável)."
  type        = bool
  default     = true
}

variable "stop_timeout" {
  description = "Segundos entre o SIGTERM e o SIGKILL (desligamento gracioso; máximo 120 no Fargate)."
  type        = number
  default     = 30

  validation {
    condition     = var.stop_timeout >= 2 && var.stop_timeout <= 120
    error_message = "Use de 2 a 120 segundos."
  }
}

variable "health_check_grace_period" {
  description = "Segundos em que o ECS ignora o health check do ALB depois de subir a task."
  type        = number
  default     = 60

  validation {
    condition     = var.health_check_grace_period >= 0 && var.health_check_grace_period <= 600
    error_message = "Use de 0 a 600 segundos."
  }
}
