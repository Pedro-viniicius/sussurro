# Registros no Route 53 (infra.md §6.2, opcional): api.<domínio> → ALB, media.<domínio> →
# CloudFront e os 3 CNAMEs do DKIM do SES. Com DNS fora da AWS, este módulo não é usado e os mesmos
# registros são criados à mão a partir das saídas do envs/prod (runbook).

resource "aws_route53_record" "api" {
  zone_id = var.zone_id
  name    = var.api_domain
  type    = "A"

  alias {
    name                   = var.alb_dns_name
    zone_id                = var.alb_zone_id
    evaluate_target_health = true
  }
}

resource "aws_route53_record" "media" {
  for_each = toset(["A", "AAAA"])

  zone_id = var.zone_id
  name    = var.media_domain
  type    = each.key

  alias {
    name                   = var.cloudfront_domain_name
    zone_id                = var.cloudfront_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "dkim" {
  count = 3

  zone_id = var.zone_id
  name    = "${var.dkim_tokens[count.index]}._domainkey.${var.ses_domain}"
  type    = "CNAME"
  ttl     = 1800
  records = ["${var.dkim_tokens[count.index]}.dkim.amazonses.com"]
}
