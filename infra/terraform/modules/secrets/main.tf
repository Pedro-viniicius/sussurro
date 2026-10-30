# Segredos da produção (infra.md §6.4 e §8, backlog 7.5). Nenhum valor no código:
# - generated_*: o Terraform gera (random_password) ou monta (DATABASE_URL, REDIS_URL). O valor fica
#   no state, que é criptografado, privado e com acesso restrito (bootstrap);
# - manual_*: nascem vazios e o valor é posto à mão (runbook). No Secrets Manager, sem versão a task
#   nem sobe; no SSM, o parâmetro nasce com "PREENCHER", que a validação do boot recusa.
# A chave KMS é a gerenciada pela AWS (aws/secretsmanager ou aws/ssm): a execution role não precisa
# de kms:Decrypt.

locals {
  use_secretsmanager = var.backend == "secretsmanager"
  all_names          = setunion(var.generated_names, var.manual_names)
}

resource "aws_secretsmanager_secret" "this" {
  for_each = local.use_secretsmanager ? local.all_names : toset([])

  name        = "${var.name_prefix}/${each.key}"
  description = contains(var.generated_names, each.key) ? "Gerado pelo Terraform" : "Preenchido a mao (docs/deploy/runbook.md)"
}

resource "aws_secretsmanager_secret_version" "generated" {
  for_each = local.use_secretsmanager ? var.generated_names : toset([])

  secret_id     = aws_secretsmanager_secret.this[each.key].id
  secret_string = var.generated_values[each.key]
}

resource "aws_ssm_parameter" "generated" {
  for_each = local.use_secretsmanager ? toset([]) : var.generated_names

  name        = "/${var.name_prefix}/${each.key}"
  description = "Gerado pelo Terraform"
  type        = "SecureString"
  tier        = "Standard"
  value       = var.generated_values[each.key]
}

resource "aws_ssm_parameter" "manual" {
  for_each = local.use_secretsmanager ? toset([]) : var.manual_names

  name        = "/${var.name_prefix}/${each.key}"
  description = "Preenchido a mao (docs/deploy/runbook.md)"
  type        = "SecureString"
  tier        = "Standard"
  value       = "PREENCHER"

  lifecycle {
    ignore_changes = [value]
  }
}

locals {
  arns = merge(
    { for k, s in aws_secretsmanager_secret.this : k => s.arn },
    { for k, p in aws_ssm_parameter.generated : k => p.arn },
    { for k, p in aws_ssm_parameter.manual : k => p.arn },
  )
}
