output "dkim_tokens" {
  description = "Os 3 tokens do DKIM: cada um vira o CNAME <token>._domainkey.<domínio> → <token>.dkim.amazonses.com."
  value       = aws_sesv2_email_identity.this.dkim_signing_attributes[0].tokens
}

output "identity_arn" {
  description = "ARN da identidade do SES."
  value       = aws_sesv2_email_identity.this.arn
}
