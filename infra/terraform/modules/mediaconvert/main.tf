# MediaConvert (ADR 0006, infra.md §6.4 e §6.5, backlog 7.4): role de serviço que só lê incoming/*
# e só grava media/*, e a regra do EventBridge que leva o fim dos jobs do Sussurro (COMPLETE e
# ERROR, userMetadata.app = sussurro) para a fila video-events.

data "aws_caller_identity" "current" {}

data "aws_iam_policy_document" "assume_mediaconvert" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["mediaconvert.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}

resource "aws_iam_role" "mediaconvert" {
  name               = "${var.name}-mediaconvert"
  description        = "MediaConvert do ${var.name}: le incoming/* e grava media/*"
  assume_role_policy = data.aws_iam_policy_document.assume_mediaconvert.json
}

# Os curingas são só de prefixo de objeto (incoming/* e media/*), não de ação nem de bucket.
#trivy:ignore:AVD-AWS-0057
data "aws_iam_policy_document" "mediaconvert" {
  statement {
    sid       = "LeOriginal"
    actions   = ["s3:GetObject"]
    resources = ["${var.bucket_arn}/incoming/*"]
  }

  statement {
    sid       = "GravaSaidas"
    actions   = ["s3:PutObject"]
    resources = ["${var.bucket_arn}/media/*"]
  }
}

resource "aws_iam_role_policy" "mediaconvert" {
  name   = "s3-incoming-media"
  role   = aws_iam_role.mediaconvert.id
  policy = data.aws_iam_policy_document.mediaconvert.json
}

resource "aws_cloudwatch_event_rule" "job_state" {
  name        = var.rule_name
  description = "Fim dos jobs do MediaConvert do Sussurro (COMPLETE e ERROR) para a fila video-events"
  event_pattern = jsonencode({
    source        = ["aws.mediaconvert"]
    "detail-type" = ["MediaConvert Job State Change"]
    detail = {
      status = ["COMPLETE", "ERROR"]
      userMetadata = {
        app = [var.app_metadata]
      }
    }
  })
}

resource "aws_cloudwatch_event_target" "video_events" {
  rule      = aws_cloudwatch_event_rule.job_state.name
  target_id = "video-events"
  arn       = var.video_events_queue_arn
}
