output "refs" {
  description = "Referência de cada segredo, por nome: { kind, arn }, no formato da entrada secrets do módulo ecs-service."
  value       = { for name in local.all_names : name => { kind = var.backend, arn = local.arns[name] } }
}

output "names" {
  description = "Nome completo de cada segredo no Secrets Manager ou no SSM (para o put-secret-value / put-parameter do runbook)."
  value = {
    for name in local.all_names : name => local.use_secretsmanager ? "${var.name_prefix}/${name}" : "/${var.name_prefix}/${name}"
  }
}

output "manual_names" {
  description = "Segredos que precisam ser preenchidos à mão antes de subir os serviços."
  value       = sort(tolist(var.manual_names))
}
