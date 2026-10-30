# Mídia (ADR 0009, infra.md §6.4, backlog 7.3):
# - S3 privado: Block Public Access, SSE-S3, só TLS, versioning com versões antigas apagadas em 7
#   dias, incoming/ expirando em 1 dia e multipart incompleto abortado em 1 dia;
# - CloudFront com OAC: só media/* é lido do bucket, e toda URL precisa de assinatura do trusted key
#   group (a chave privada fica no Secrets Manager/SSM e a API assina URLs de 6 h);
# - cache sem query string na chave (a assinatura não fragmenta o cache).

# SSE-S3 (infra.md §6.4): sem chave KMS própria, porque o CloudFront com OAC e o MediaConvert
# precisariam de permissão na chave, e o custo por requisição do KMS cresce com a mídia servida.
#trivy:ignore:AVD-AWS-0132
resource "aws_s3_bucket" "media" {
  bucket        = var.bucket_name
  force_destroy = false
}

resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "media" {
  bucket = aws_s3_bucket.media.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    id     = "incoming-expira"
    status = "Enabled"

    filter {
      prefix = "incoming/"
    }

    expiration {
      days = var.incoming_expiration_days
    }

    noncurrent_version_expiration {
      noncurrent_days = var.incoming_expiration_days
    }
  }

  rule {
    id     = "versoes-antigas"
    status = "Enabled"

    filter {}

    expiration {
      expired_object_delete_marker = true
    }

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_expiration_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.media]
}

data "aws_iam_policy_document" "media_bucket" {
  statement {
    sid       = "SoTLS"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.media.arn, "${aws_s3_bucket.media.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "CloudFrontLeSoMedia"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/media/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.media.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.media_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.media]
}

# --- CloudFront ---

resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "${var.name}-media"
  description                       = "OAC do bucket de midia do ${var.name}"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_public_key" "this" {
  for_each = var.public_keys

  name        = "${var.name}-media-${each.key}"
  comment     = "Assinatura das URLs de midia (${each.key})"
  encoded_key = each.value
}

resource "aws_cloudfront_key_group" "media" {
  name    = "${var.name}-media"
  comment = "Chaves que assinam as URLs de midia do ${var.name}"
  items   = [for k in sort(keys(var.public_keys)) : aws_cloudfront_public_key.this[k].id]
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

resource "aws_acm_certificate" "media" {
  provider = aws.us_east_1

  domain_name       = var.domain_name
  validation_method = "DNS"
  key_algorithm     = "RSA_2048"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "validation" {
  for_each = var.validate_with_route53 ? {
    for dvo in aws_acm_certificate.media.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      type   = dvo.resource_record_type
      record = dvo.resource_record_value
    }
  } : {}

  zone_id         = var.route53_zone_id
  name            = each.value.name
  type            = each.value.type
  records         = [each.value.record]
  ttl             = 300
  allow_overwrite = true
}

resource "aws_acm_certificate_validation" "media" {
  provider = aws.us_east_1

  certificate_arn         = aws_acm_certificate.media.arn
  validation_record_fqdns = var.validate_with_route53 ? [for r in aws_route53_record.validation : r.fqdn] : null
}

# WAF fora da v1 (infra.md §6.4): sem URL assinada válida o CloudFront já responde 403, e o abuso de
# custo é vigiado pelo orçamento de MediaConvert e CloudFront (7.9). Logs do CloudFront desligados:
# não há guarda de registros prevista para a mídia (L3 cobre só a API; decisão do PO).
#trivy:ignore:AVD-AWS-0011
resource "aws_cloudfront_distribution" "media" {
  enabled         = true
  comment         = "Midia do ${var.name} (URLs assinadas)"
  aliases         = [var.domain_name]
  is_ipv6_enabled = true
  http_version    = "http2and3"
  price_class     = var.price_class

  origin {
    origin_id                = "media-s3"
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  default_cache_behavior {
    target_origin_id       = "media-s3"
    viewer_protocol_policy = "https-only"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = false
    cache_policy_id        = data.aws_cloudfront_cache_policy.caching_optimized.id
    trusted_key_groups     = [aws_cloudfront_key_group.media.id]
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.media.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}
