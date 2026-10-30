# Roles de menor privilégio (infra.md §6.5, backlog 7.5 CA2). As execution roles ficam no módulo
# ecs-service (uma por task, só com os segredos dela). Aqui: as task roles da API e do worker, que o
# código usa para falar com S3, SQS, SES e MediaConvert, e a role de deploy do GitHub (OIDC, só a
# branch main, sem chave de longa duração).

locals {
  ecs_arn_prefix = "arn:aws:ecs:${var.region}:${var.aws_account_id}"
}

data "aws_iam_policy_document" "assume_ecs_tasks" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["${local.ecs_arn_prefix}:*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.aws_account_id]
    }
  }
}

# --- API ---

resource "aws_iam_role" "api" {
  name               = "${var.name}-api-task"
  description        = "Codigo da API: presign em incoming, leitura e exclusao de midia, filas e SES"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

# Curingas só de prefixo de objeto (incoming/* e media/*) e de identidade do SES (o remetente e, no
# sandbox, os destinatários verificados).
#trivy:ignore:AVD-AWS-0057
data "aws_iam_policy_document" "api" {
  statement {
    sid       = "PresignUpload"
    actions   = ["s3:PutObject"]
    resources = ["${var.media_bucket_arn}/incoming/*"]
  }

  statement {
    sid       = "LeUploadEMidia"
    actions   = ["s3:GetObject"]
    resources = ["${var.media_bucket_arn}/incoming/*", "${var.media_bucket_arn}/media/*"]
  }

  statement {
    sid       = "ApagaMidia"
    actions   = ["s3:DeleteObject"]
    resources = ["${var.media_bucket_arn}/media/*"]
  }

  statement {
    sid       = "EnviaParaFilas"
    actions   = ["sqs:GetQueueUrl", "sqs:SendMessage"]
    resources = var.api_queue_arns
  }

  statement {
    sid       = "EmailSes"
    actions   = ["ses:SendEmail"]
    resources = ["arn:aws:ses:${var.region}:${var.aws_account_id}:identity/*"]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}

# --- Worker ---

resource "aws_iam_role" "worker" {
  name               = "${var.name}-worker-task"
  description        = "Codigo do worker: filas, incoming e media no S3 e jobs do MediaConvert"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

# s3:ListBucket no bucket: sem ele, o S3 responde 403 (e não 404) para objeto que não existe, e o
# worker trataria "o original sumiu" como erro temporário. Curingas só de prefixo e de job.
#trivy:ignore:AVD-AWS-0057
data "aws_iam_policy_document" "worker" {
  statement {
    sid       = "ConsomeFilas"
    actions   = ["sqs:GetQueueUrl", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:ChangeMessageVisibility"]
    resources = var.worker_queue_arns
  }

  statement {
    sid       = "LeUpload"
    actions   = ["s3:GetObject"]
    resources = ["${var.media_bucket_arn}/incoming/*"]
  }

  statement {
    sid       = "GravaMidia"
    actions   = ["s3:PutObject"]
    resources = ["${var.media_bucket_arn}/media/*"]
  }

  statement {
    sid       = "ApagaUploadEMidia"
    actions   = ["s3:DeleteObject"]
    resources = ["${var.media_bucket_arn}/incoming/*", "${var.media_bucket_arn}/media/*"]
  }

  statement {
    sid       = "ListaBucket"
    actions   = ["s3:ListBucket"]
    resources = [var.media_bucket_arn]
  }

  statement {
    sid       = "CriaJobs"
    actions   = ["mediaconvert:CreateJob"]
    resources = [var.mediaconvert_queue_arn, "arn:aws:mediaconvert:${var.region}:${var.aws_account_id}:jobs/*"]
  }

  statement {
    sid       = "PassaRoleDoMediaConvert"
    actions   = ["iam:PassRole"]
    resources = [var.mediaconvert_role_arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["mediaconvert.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "worker" {
  name   = "worker"
  role   = aws_iam_role.worker.id
  policy = data.aws_iam_policy_document.worker.json
}

# --- Deploy pelo GitHub Actions (OIDC; usado pelo deploy.yml depois do apply autorizado) ---

data "aws_iam_policy_document" "assume_github" {
  count = var.github_repository == "" ? 0 : 1

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.github_oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repository}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "deploy" {
  count = var.github_repository == "" ? 0 : 1

  name                 = "${var.name}-github-deploy"
  description          = "Deploy pelo GitHub Actions (OIDC, so a main): imagens no ECR, migration e update-service"
  assume_role_policy   = data.aws_iam_policy_document.assume_github[0].json
  max_session_duration = 3600
}

# ecr:GetAuthorizationToken, ecs:RegisterTaskDefinition e ecs:DescribeTaskDefinition não aceitam
# recurso específico (exigem "*"). O resto fica restrito aos repositórios, serviços, famílias e roles.
#trivy:ignore:AVD-AWS-0057
data "aws_iam_policy_document" "deploy" {
  count = var.github_repository == "" ? 0 : 1

  statement {
    sid       = "EcrAuth"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  statement {
    sid       = "EcrPush"
    actions   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:CompleteLayerUpload", "ecr:DescribeImages", "ecr:GetDownloadUrlForLayer", "ecr:InitiateLayerUpload", "ecr:PutImage", "ecr:UploadLayerPart"]
    resources = var.ecr_repository_arns
  }

  statement {
    sid       = "TaskDefinitions"
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"]
  }

  statement {
    sid       = "AtualizaServicos"
    actions   = ["ecs:DescribeServices", "ecs:UpdateService"]
    resources = [for s in var.deploy_service_names : "${local.ecs_arn_prefix}:service/${var.ecs_cluster_name}/${s}"]
  }

  statement {
    sid       = "RodaMigration"
    actions   = ["ecs:RunTask"]
    resources = [for f in var.deploy_task_families : "${local.ecs_arn_prefix}:task-definition/${f}:*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = ["${local.ecs_arn_prefix}:cluster/${var.ecs_cluster_name}"]
    }
  }

  statement {
    sid       = "AcompanhaTasks"
    actions   = ["ecs:DescribeTasks"]
    resources = ["${local.ecs_arn_prefix}:task/${var.ecs_cluster_name}/*"]
  }

  statement {
    sid       = "PassaRolesDasTasks"
    actions   = ["iam:PassRole"]
    resources = concat([aws_iam_role.api.arn, aws_iam_role.worker.arn], var.deploy_execution_role_arns)

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "deploy" {
  count = var.github_repository == "" ? 0 : 1

  name   = "deploy"
  role   = aws_iam_role.deploy[0].id
  policy = data.aws_iam_policy_document.deploy[0].json
}
