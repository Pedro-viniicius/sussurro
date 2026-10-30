output "bucket_name" {
  description = "Bucket de mídia (S3_BUCKET_MEDIA)."
  value       = aws_s3_bucket.media.bucket
}

output "bucket_arn" {
  description = "ARN do bucket de mídia."
  value       = aws_s3_bucket.media.arn
}

output "distribution_arn" {
  description = "ARN da distribuição do CloudFront."
  value       = aws_cloudfront_distribution.media.arn
}

output "distribution_domain_name" {
  description = "Domínio *.cloudfront.net (alvo do registro media.<domínio>)."
  value       = aws_cloudfront_distribution.media.domain_name
}

output "distribution_hosted_zone_id" {
  description = "Zona hospedada do CloudFront (para o alias no Route 53)."
  value       = aws_cloudfront_distribution.media.hosted_zone_id
}

output "public_key_ids" {
  description = "Id de cada chave pública no CloudFront, por apelido (o da chave ativa vira CLOUDFRONT_KEY_PAIR_ID)."
  value       = { for k, key in aws_cloudfront_public_key.this : k => key.id }
}

output "certificate_validation_records" {
  description = "Registros CNAME de validação do certificado em us-east-1 (crie à mão se o DNS for externo)."
  value = [
    for dvo in aws_acm_certificate.media.domain_validation_options : {
      name  = dvo.resource_record_name
      type  = dvo.resource_record_type
      value = dvo.resource_record_value
    }
  ]
}
