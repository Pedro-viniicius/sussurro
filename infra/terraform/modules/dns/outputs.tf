output "api_fqdn" {
  description = "Registro da API no Route 53."
  value       = aws_route53_record.api.fqdn
}

output "media_fqdn" {
  description = "Registro da mídia no Route 53."
  value       = aws_route53_record.media["A"].fqdn
}
