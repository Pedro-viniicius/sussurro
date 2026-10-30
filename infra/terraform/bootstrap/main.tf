# Bootstrap (infra.md §6.2): aplicado UMA vez, à mão e só com autorização do PO, antes do envs/prod.
# - bucket do state remoto (versioning, SSE, Block Public Access, só TLS; lock nativo do S3);
# - orçamentos e detecção de anomalias de custo (7.9), valendo antes de qualquer recurso pago;
# - provedor OIDC do GitHub (deploy sem chave de longa duração);
# - zona do Route 53 do domínio (opcional).

locals {
  tags = {
    Project   = var.project
    ManagedBy = "terraform"
    Stack     = "bootstrap"
  }
}

# --- State remoto ---

# SSE-S3 com Block Public Access, só TLS e acesso restrito pelo IAM. O state guarda as senhas geradas
# (banco e Valkey): quem lê o state lê as senhas, então o acesso a este bucket é só de administrador.
#trivy:ignore:AVD-AWS-0132
resource "aws_s3_bucket" "state" {
  bucket        = "${var.project}-tfstate-${var.aws_account_id}"
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket                  = aws_s3_bucket.state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# O Trivy aponta o AVD-AWS-0132 neste bloco (não no bucket): a exceção precisa ficar aqui também.
#trivy:ignore:AVD-AWS-0132
resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    id     = "versoes-antigas-do-state"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 90
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }

  depends_on = [aws_s3_bucket_versioning.state]
}

data "aws_iam_policy_document" "state" {
  statement {
    sid       = "SoTLS"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.state.arn, "${aws_s3_bucket.state.arn}/*"]

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
}

resource "aws_s3_bucket_policy" "state" {
  bucket = aws_s3_bucket.state.id
  policy = data.aws_iam_policy_document.state.json

  depends_on = [aws_s3_bucket_public_access_block.state]
}

# --- Custo (7.9) ---

module "budgets" {
  source = "../modules/budgets"

  providers = {
    aws = aws.us_east_1
  }

  name                = var.project
  email               = var.cost_alert_email
  monthly_limit_usd   = var.monthly_budget_usd
  media_limit_usd     = var.media_budget_usd
  anomaly_monitor_arn = var.anomaly_monitor_arn
}

# --- GitHub OIDC ---

# A AWS valida o certificado do GitHub pela própria cadeia de confiança; as impressões digitais
# abaixo (públicas) só satisfazem o campo.
resource "aws_iam_openid_connect_provider" "github" {
  count = var.github_oidc_enabled ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1", "1c58a3a8518e8759bf075b76b750d4f2df264fcd"]
}

# --- DNS (opcional) ---

resource "aws_route53_zone" "this" {
  count = var.create_dns_zone ? 1 : 0

  name          = var.domain_name
  comment       = "Dominio do ${var.project} (registros do envs/prod)"
  force_destroy = false
}
