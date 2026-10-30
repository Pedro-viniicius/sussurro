# Alarmes de custo (infra.md §7 e backlog 7.9): orçamento mensal com alertas a 50%, 80% e 100% do
# gasto real e 100% do previsto, um orçamento só para MediaConvert + CloudFront (o maior risco de
# custo é o vídeo, R10 e I6) e o Cost Anomaly Detection (grátis).

locals {
  actual_thresholds = [50, 80, 100]
}

resource "aws_budgets_budget" "monthly" {
  name         = "${var.name}-mensal"
  budget_type  = "COST"
  limit_amount = format("%.1f", var.monthly_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  dynamic "notification" {
    for_each = local.actual_thresholds

    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.email]
    }
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.email]
  }
}

resource "aws_budgets_budget" "media" {
  name         = "${var.name}-mediaconvert-cloudfront"
  budget_type  = "COST"
  limit_amount = format("%.1f", var.media_limit_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  cost_filter {
    name   = "Service"
    values = ["AWS Elemental MediaConvert", "Amazon CloudFront"]
  }

  dynamic "notification" {
    for_each = local.actual_thresholds

    content {
      comparison_operator        = "GREATER_THAN"
      threshold                  = notification.value
      threshold_type             = "PERCENTAGE"
      notification_type          = "ACTUAL"
      subscriber_email_addresses = [var.email]
    }
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.email]
  }
}

resource "aws_ce_anomaly_monitor" "services" {
  count = var.anomaly_monitor_arn == "" ? 1 : 0

  name              = "${var.name}-servicos"
  monitor_type      = "DIMENSIONAL"
  monitor_dimension = "SERVICE"
}

resource "aws_ce_anomaly_subscription" "daily" {
  name             = "${var.name}-anomalias"
  frequency        = "DAILY"
  monitor_arn_list = [coalesce(var.anomaly_monitor_arn, one(aws_ce_anomaly_monitor.services[*].arn))]

  subscriber {
    type    = "EMAIL"
    address = var.email
  }

  threshold_expression {
    dimension {
      key           = "ANOMALY_TOTAL_IMPACT_ABSOLUTE"
      match_options = ["GREATER_THAN_OR_EQUAL"]
      values        = [tostring(var.anomaly_threshold_usd)]
    }
  }
}
