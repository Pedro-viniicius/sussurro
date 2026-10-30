output "bucket_name" {
  description = "Bucket dos logs de acesso (só existe depois da política que libera o ELB, que o ALB confere ao ligar os logs)."
  value       = aws_s3_bucket.this.bucket

  depends_on = [aws_s3_bucket_policy.this]
}
