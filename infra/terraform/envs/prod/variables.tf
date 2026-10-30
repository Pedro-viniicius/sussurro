# Variáveis da produção. Valores reais (conta, domínio, e-mails, chaves públicas) só no prod.tfvars,
# que fica fora do Git; o modelo é o prod.tfvars.example. Nenhuma variável recebe segredo: senhas e
# chaves privadas são geradas pelo Terraform ou postas à mão no Secrets Manager/SSM (runbook).

# --- Conta, região e porte ---

variable "aws_account_id" {
  description = "Conta da AWS da produção (o provider recusa aplicar em qualquer outra)."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Informe os 12 dígitos da conta."
  }
}

variable "region" {
  description = "Região (D12: sa-east-1, dados no Brasil; a confirmar pelo PO)."
  type        = string
  default     = "sa-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.region))
    error_message = "Informe uma região da AWS (ex.: sa-east-1)."
  }
}

variable "project" {
  description = "Nome do projeto (prefixo dos recursos)."
  type        = string
  default     = "sussurro"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,12}$", var.project))
    error_message = "Use de 3 a 13 caracteres: letras minúsculas, números e hífen."
  }
}

variable "environment" {
  description = "Ambiente (prod; o staging fica fora da v1, infra.md §2)."
  type        = string
  default     = "prod"

  validation {
    condition     = contains(["prod", "staging"], var.environment)
    error_message = "Use prod ou staging."
  }
}

variable "porte" {
  description = "Porte do lançamento (P5/D12): enxuto (~US$ 155/mês: RDS micro Single-AZ, 1 task da API, worker no Spot, segredos no SSM, logs IA) ou completo (~US$ 285/mês: RDS small Multi-AZ, 2 tasks, Secrets Manager, logs Standard). Padrão: enxuto, a recomendação do P5; o PO confirma."
  type        = string
  default     = "enxuto"

  validation {
    condition     = contains(["enxuto", "completo"], var.porte)
    error_message = "Use enxuto ou completo."
  }
}

variable "secrets_backend" {
  description = "Sobrepõe o local dos segredos do porte (secretsmanager ou ssm). Ao subir de porte, fixe o valor atual para não recriar os segredos. null = o do porte."
  type        = string
  default     = null

  validation {
    condition     = var.secrets_backend == null ? true : contains(["secretsmanager", "ssm"], var.secrets_backend)
    error_message = "Use secretsmanager, ssm ou null."
  }
}

variable "log_group_class" {
  description = "Sobrepõe a classe dos log groups do porte (STANDARD ou INFREQUENT_ACCESS). Trocar recria os log groups e apaga o histórico. null = a do porte."
  type        = string
  default     = null

  validation {
    condition     = var.log_group_class == null ? true : contains(["STANDARD", "INFREQUENT_ACCESS"], var.log_group_class)
    error_message = "Use STANDARD, INFREQUENT_ACCESS ou null."
  }
}

# --- Rede ---

variable "vpc_cidr" {
  description = "Faixa da VPC (infra.md §6.1)."
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "Informe um bloco CIDR IPv4."
  }
}

variable "availability_zones" {
  description = "Duas zonas da região (sa-east-1a e sa-east-1c têm todos os serviços usados)."
  type        = list(string)
  default     = ["sa-east-1a", "sa-east-1c"]

  validation {
    condition     = length(var.availability_zones) == 2
    error_message = "Informe exatamente duas zonas."
  }
}

# --- Domínio e DNS (P6) ---

variable "domain_name" {
  description = "Domínio do app (P6, decisão do PO), ex.: example.com. A API fica em api.<domínio> e a mídia em media.<domínio>."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9-]+\\.)+[a-z]{2,}$", var.domain_name))
    error_message = "Informe um domínio válido, em minúsculas."
  }
}

variable "dns_mode" {
  description = "route53 (a zona criada pelo bootstrap; registros e validações automáticos) ou external (DNS fora da AWS; os registros saem nas saídas e são criados à mão)."
  type        = string
  default     = "route53"

  validation {
    condition     = contains(["route53", "external"], var.dns_mode)
    error_message = "Use route53 ou external."
  }
}

# --- Deploy ---

variable "image_tag" {
  description = "Tag das imagens da API e do worker no ECR: o SHA do commit (tags imutáveis). Mudar registra revisões novas das task definitions; o serviço só troca no update-service (runbook)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{7,40}$", var.image_tag))
    error_message = "Use o SHA do commit (7 a 40 caracteres hexadecimais)."
  }
}

variable "services_enabled" {
  description = "false = cria tudo menos os serviços da API e do worker (primeiro apply: antes das imagens, dos segredos e das migrations). true = serviços no ar."
  type        = bool
  default     = true
}

variable "github_repository" {
  description = "Repositório do GitHub (dono/nome) autorizado a fazer deploy pela role OIDC (precisa do bootstrap com github_oidc_enabled). Vazio = sem role de deploy."
  type        = string
  default     = ""

  validation {
    condition     = var.github_repository == "" || can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repository))
    error_message = "Use o formato dono/nome (ou deixe vazio)."
  }
}

# --- Aplicação ---

variable "alarm_email" {
  description = "E-mail que recebe os alarmes do CloudWatch (confirmar a inscrição do SNS)."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "Informe um e-mail válido."
  }
}

variable "moderation_email" {
  description = "MODERATION_EMAIL da API: recebe as denúncias (X.1). Obrigatória em produção."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.moderation_email))
    error_message = "Informe um e-mail válido."
  }
}

variable "email_from" {
  description = "EMAIL_FROM da API. Vazio = \"Sussurro <nao-responda@<domínio>>\". O domínio do remetente precisa ser o da identidade do SES."
  type        = string
  default     = ""
}

variable "email_link_base_url" {
  description = "EMAIL_LINK_BASE_URL da API: início dos links dos e-mails. sussurro:// abre o app direto; um https exige uma página ou universal links no domínio (decisão pendente, runbook)."
  type        = string
  default     = "sussurro://"

  validation {
    condition     = can(regex("^(sussurro://|https://[^\\s]+)$", var.email_link_base_url))
    error_message = "Use sussurro:// ou uma URL https."
  }
}

variable "jwt_access_kid" {
  description = "JWT_ACCESS_KID: kid do segredo atual do JWT (troque junto com o segredo na rotação)."
  type        = string
  default     = "k1"

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]{1,32}$", var.jwt_access_kid))
    error_message = "Use até 32 letras, números, hífen ou sublinhado."
  }
}

variable "jwt_previous_enabled" {
  description = "Durante uma rotação do JWT: injeta JWT_ACCESS_PREVIOUS_SECRET (segredo jwt-access-previous-secret, que existe sempre) e JWT_ACCESS_PREVIOUS_KID. Desligue depois de 15 min (validade do access token)."
  type        = bool
  default     = false
}

variable "jwt_previous_kid" {
  description = "JWT_ACCESS_PREVIOUS_KID (só com jwt_previous_enabled; diferente do jwt_access_kid)."
  type        = string
  default     = ""

  validation {
    condition     = !var.jwt_previous_enabled || (var.jwt_previous_kid != "" && var.jwt_previous_kid != var.jwt_access_kid)
    error_message = "Com jwt_previous_enabled, informe o kid anterior, diferente do jwt_access_kid."
  }
}

variable "expo_access_token_enabled" {
  description = "Cria e injeta o EXPO_ACCESS_TOKEN (segredo expo-access-token), se a segurança reforçada de push estiver ligada no projeto do Expo."
  type        = bool
  default     = false
}

variable "cloudfront_public_keys" {
  description = "Chaves públicas RSA 2048 (PEM) que verificam as URLs de mídia, por apelido (ex.: k1). A privada correspondente vai à mão para o segredo cloudfront-private-key."
  type        = map(string)

  validation {
    condition     = length(var.cloudfront_public_keys) >= 1 && alltrue([for v in values(var.cloudfront_public_keys) : strcontains(v, "BEGIN PUBLIC KEY")])
    error_message = "Informe ao menos uma chave pública em PEM (BEGIN PUBLIC KEY)."
  }
}

variable "cloudfront_active_key" {
  description = "Apelido da chave com que a API assina (vira CLOUDFRONT_KEY_PAIR_ID). Precisa casar com a privada do segredo cloudfront-private-key."
  type        = string
  default     = "k1"

  validation {
    condition     = contains(keys(var.cloudfront_public_keys), var.cloudfront_active_key)
    error_message = "cloudfront_active_key precisa ser um dos apelidos de cloudfront_public_keys."
  }
}

variable "mediaconvert_queue_arn" {
  description = "MEDIACONVERT_QUEUE_ARN do worker. Vazio = a fila Default da conta."
  type        = string
  default     = ""

  validation {
    condition     = var.mediaconvert_queue_arn == "" || can(regex("^arn:aws[a-z-]*:mediaconvert:[a-z0-9-]+:[0-9]{12}:queues/[A-Za-z0-9_-]+$", var.mediaconvert_queue_arn))
    error_message = "Informe o ARN de uma fila do MediaConvert ou deixe vazio."
  }
}

variable "sentry_dsn_api" {
  description = "SENTRY_DSN da API (projeto sussurro-api). Não é segredo, mas fica fora do Git. Vazio = Sentry desligado (D4)."
  type        = string
  default     = ""

  validation {
    condition     = var.sentry_dsn_api == "" || startswith(var.sentry_dsn_api, "https://")
    error_message = "Use o DSN https do Sentry ou deixe vazio."
  }
}

variable "sentry_dsn_worker" {
  description = "SENTRY_DSN do worker (projeto sussurro-worker). Vazio = Sentry desligado."
  type        = string
  default     = ""

  validation {
    condition     = var.sentry_dsn_worker == "" || startswith(var.sentry_dsn_worker, "https://")
    error_message = "Use o DSN https do Sentry ou deixe vazio."
  }
}

variable "sentry_traces_sample_rate" {
  description = "SENTRY_TRACES_SAMPLE_RATE da API e do worker (infra.md §7: 0,05 a 0,1 cabe no plano)."
  type        = number
  default     = 0.05

  validation {
    condition     = var.sentry_traces_sample_rate >= 0 && var.sentry_traces_sample_rate <= 1
    error_message = "Use um valor de 0 a 1."
  }
}

# --- Proteções ---

variable "deletion_protection" {
  description = "Proteção contra exclusão do ALB e do RDS. Só desligue para destruir o ambiente de propósito."
  type        = bool
  default     = true
}

variable "rds_performance_insights" {
  description = "Liga o Performance Insights do RDS (grátis por 7 dias de retenção; confirme que a classe aceita)."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "Retenção dos logs da API, do worker e das tasks avulsas (infra.md §7: 30 dias)."
  type        = number
  default     = 30

  validation {
    condition     = contains([7, 14, 30, 60, 90], var.log_retention_days)
    error_message = "Use 7, 14, 30, 60 ou 90 dias."
  }
}

# --- Guarda de registros de acesso (Marco Civil, art. 15; L3) ---

variable "access_log_retention_enabled" {
  description = "L3: liga os logs de acesso do ALB num bucket com guarda de 6 meses, acesso restrito e criptografia. DESLIGADO até o PO confirmar; ligar muda a Política de Privacidade (runbook)."
  type        = bool
  default     = false
}

variable "access_log_retention_days" {
  description = "Dias de guarda dos logs de acesso (mínimo de 6 meses)."
  type        = number
  default     = 185

  validation {
    condition     = var.access_log_retention_days >= 184 && var.access_log_retention_days <= 400
    error_message = "Use de 184 a 400 dias."
  }
}

variable "access_log_reader_arns" {
  description = "Únicos principals que podem ler os logs de acesso (ex.: uma role usada só para ordens judiciais). Vazio = quem tiver permissão no IAM."
  type        = list(string)
  default     = []
}
