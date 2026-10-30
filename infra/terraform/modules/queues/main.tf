# Filas SQS com DLQ (infra.md §6.4, backlog 7.4): redrive depois de 3 entregas, DLQ com 14 dias,
# SSE-SQS, long polling de 20 s e só TLS. Uma fila com allowed_source_rule_arns (a video-events)
# recebe mensagens só dessas regras do EventBridge: qualquer outro remetente é negado.

# O "sqs:*" e o principal "*" estão só em instruções Deny (negar tudo sem TLS e todo remetente que
# não seja a regra); as permissões (Allow) são de uma ação e um serviço.
#trivy:ignore:AVD-AWS-0097
data "aws_iam_policy_document" "deny_insecure_transport" {
  for_each = var.queues

  statement {
    sid       = "SoTLS"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [aws_sqs_queue.main[each.key].arn]

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

#trivy:ignore:AVD-AWS-0097
data "aws_iam_policy_document" "main" {
  for_each = var.queues

  source_policy_documents = [data.aws_iam_policy_document.deny_insecure_transport[each.key].json]

  dynamic "statement" {
    for_each = length(each.value.allowed_source_rule_arns) > 0 ? [1] : []

    content {
      sid       = "EventBridgeEnvia"
      actions   = ["sqs:SendMessage"]
      resources = [aws_sqs_queue.main[each.key].arn]

      principals {
        type        = "Service"
        identifiers = ["events.amazonaws.com"]
      }

      condition {
        test     = "ArnEquals"
        variable = "aws:SourceArn"
        values   = each.value.allowed_source_rule_arns
      }
    }
  }

  # Ninguém mais envia: sem o aws:SourceArn da regra (qualquer usuário ou role da conta, inclusive
  # as tasks), o envio é negado.
  dynamic "statement" {
    for_each = length(each.value.allowed_source_rule_arns) > 0 ? [1] : []

    content {
      sid       = "SoARegraEnvia"
      effect    = "Deny"
      actions   = ["sqs:SendMessage"]
      resources = [aws_sqs_queue.main[each.key].arn]

      principals {
        type        = "*"
        identifiers = ["*"]
      }

      condition {
        test     = "ArnNotEquals"
        variable = "aws:SourceArn"
        values   = each.value.allowed_source_rule_arns
      }
    }
  }
}

# SSE-SQS (chave gerenciada pelo SQS, sem custo): as mensagens levam só ids (ADR 0011) e o
# EventBridge entrega numa fila SSE-SQS sem política de chave KMS.
#trivy:ignore:AVD-AWS-0135
resource "aws_sqs_queue" "dlq" {
  for_each = var.queues

  name                      = "${var.name}-${each.key}-dlq"
  message_retention_seconds = var.dlq_retention_seconds
  sqs_managed_sse_enabled   = true
}

#trivy:ignore:AVD-AWS-0135
resource "aws_sqs_queue" "main" {
  for_each = var.queues

  name                       = "${var.name}-${each.key}"
  visibility_timeout_seconds = each.value.visibility_timeout_seconds
  message_retention_seconds  = var.message_retention_seconds
  receive_wait_time_seconds  = var.receive_wait_time_seconds
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq[each.key].arn
    maxReceiveCount     = var.max_receive_count
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  for_each = var.queues

  queue_url = aws_sqs_queue.dlq[each.key].id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.main[each.key].arn]
  })
}

resource "aws_sqs_queue_policy" "main" {
  for_each = var.queues

  queue_url = aws_sqs_queue.main[each.key].id
  policy    = data.aws_iam_policy_document.main[each.key].json
}

#trivy:ignore:AVD-AWS-0097
data "aws_iam_policy_document" "dlq" {
  for_each = var.queues

  statement {
    sid       = "SoTLS"
    effect    = "Deny"
    actions   = ["sqs:*"]
    resources = [aws_sqs_queue.dlq[each.key].arn]

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

resource "aws_sqs_queue_policy" "dlq" {
  for_each = var.queues

  queue_url = aws_sqs_queue.dlq[each.key].id
  policy    = data.aws_iam_policy_document.dlq[each.key].json
}
