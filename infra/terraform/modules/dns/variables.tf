variable "zone_id" {
  description = "Zona do Route 53 do domínio (criada pelo bootstrap)."
  type        = string
}

variable "api_domain" {
  description = "Nome da API (ex.: api.example.com)."
  type        = string
}

variable "alb_dns_name" {
  description = "Nome DNS do ALB."
  type        = string
}

variable "alb_zone_id" {
  description = "Zona hospedada do ALB."
  type        = string
}

variable "media_domain" {
  description = "Nome da mídia (ex.: media.example.com)."
  type        = string
}

variable "cloudfront_domain_name" {
  description = "Domínio *.cloudfront.net da distribuição de mídia."
  type        = string
}

variable "cloudfront_zone_id" {
  description = "Zona hospedada do CloudFront."
  type        = string
}

variable "ses_domain" {
  description = "Domínio da identidade do SES (os CNAMEs do DKIM ficam nele)."
  type        = string
}

variable "dkim_tokens" {
  description = "Os 3 tokens do DKIM do SES."
  type        = list(string)
}
