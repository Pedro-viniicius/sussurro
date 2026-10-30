output "arn_suffix" {
  description = "Sufixo do ARN do ALB (dimensão LoadBalancer das métricas)."
  value       = aws_lb.this.arn_suffix
}

output "dns_name" {
  description = "Nome DNS do ALB (alvo do registro api.<domínio>)."
  value       = aws_lb.this.dns_name
}

output "zone_id" {
  description = "Zona hospedada do ALB (para o alias no Route 53)."
  value       = aws_lb.this.zone_id
}

output "target_group_arn" {
  description = "Target group da API (só fica pronto depois do listener HTTPS, que o serviço exige)."
  value       = aws_lb_target_group.api.arn

  depends_on = [aws_lb_listener.https]
}

output "target_group_arn_suffix" {
  description = "Sufixo do ARN do target group (dimensão TargetGroup das métricas)."
  value       = aws_lb_target_group.api.arn_suffix
}

output "certificate_validation_records" {
  description = "Registros CNAME de validação do certificado (crie à mão se o DNS for externo)."
  value = [
    for dvo in aws_acm_certificate.this.domain_validation_options : {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  ]
}
