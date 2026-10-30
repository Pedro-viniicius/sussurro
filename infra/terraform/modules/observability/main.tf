# Alarmes (infra.md §7): SNS → e-mail do PO. ALB (5xx, p95, hosts), ECS (CPU e memória), RDS,
# Valkey, DLQs, idade da fila (worker parado) e jobs do MediaConvert com erro. Os orçamentos de custo
# (7.9) ficam no bootstrap, para valerem antes de qualquer recurso pago.

locals {
  actions = [aws_sns_topic.alarms.arn]

  ecs_alarms = merge(
    { for k, s in var.ecs_service_names : "${k}-cpu" => { service = s, metric = "CPUUtilization", label = "CPU" } },
    { for k, s in var.ecs_service_names : "${k}-memoria" => { service = s, metric = "MemoryUtilization", label = "memória" } },
  )
}

# As mensagens dos alarmes só têm nomes de métricas e de recursos (nenhum dado de pessoa), e a chave
# gerenciada aws/sns não deixa o CloudWatch publicar no tópico (exigiria uma chave KMS paga).
#trivy:ignore:AVD-AWS-0095
resource "aws_sns_topic" "alarms" {
  name = "${var.name}-alarmes"
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

# --- ALB e API ---

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${var.name}-api-5xx"
  alarm_description   = "Mais de 1% de respostas 5xx (ALB + API) em 5 min, com pelo menos 20 requisições."
  comparison_operator = "GreaterThanThreshold"
  threshold           = 1
  evaluation_periods  = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions

  metric_query {
    id          = "taxa"
    expression  = "IF(FILL(m3, 0) >= 20, 100 * (FILL(m1, 0) + FILL(m2, 0)) / m3, 0)"
    label       = "Percentual de 5xx"
    return_data = true
  }

  metric_query {
    id = "m1"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_ELB_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
      }
    }
  }

  metric_query {
    id = "m2"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "HTTPCode_Target_5XX_Count"
      period      = 300
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
      }
    }
  }

  metric_query {
    id = "m3"

    metric {
      namespace   = "AWS/ApplicationELB"
      metric_name = "RequestCount"
      period      = 300
      stat        = "Sum"
      dimensions = {
        LoadBalancer = var.alb_arn_suffix
      }
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "alb_latency_p95" {
  alarm_name          = "${var.name}-api-latencia-p95"
  alarm_description   = "Tempo de resposta p95 da API acima de 1 s em 5 min."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "TargetResponseTime"
  extended_statistic  = "p95"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  alarm_name          = "${var.name}-api-tasks-nao-saudaveis"
  alarm_description   = "Alguma task da API falha no /health/ready há 5 min."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.target_group_arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "no_healthy_hosts" {
  alarm_name          = "${var.name}-api-sem-task-saudavel"
  alarm_description   = "Nenhuma task da API saudável há 3 min: a API está fora do ar."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 3
  comparison_operator = "LessThanThreshold"
  threshold           = 1
  treat_missing_data  = "breaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
    TargetGroup  = var.target_group_arn_suffix
  }
}

# --- ECS ---

resource "aws_cloudwatch_metric_alarm" "ecs" {
  for_each = local.ecs_alarms

  alarm_name          = "${var.name}-${each.key}"
  alarm_description   = "Uso de ${each.value.label} de ${each.value.service} acima de 85% por 15 min."
  namespace           = "AWS/ECS"
  metric_name         = each.value.metric
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = 85
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = each.value.service
  }
}

# --- RDS ---

resource "aws_cloudwatch_metric_alarm" "rds" {
  for_each = {
    cpu = {
      metric      = "CPUUtilization"
      statistic   = "Average"
      operator    = "GreaterThanThreshold"
      threshold   = 80
      description = "CPU do RDS acima de 80% por 15 min."
    }
    disco = {
      metric      = "FreeStorageSpace"
      statistic   = "Minimum"
      operator    = "LessThanThreshold"
      threshold   = var.rds_free_storage_threshold_bytes
      description = "Disco livre do RDS abaixo de 20% (o autoscaling de disco tem teto)."
    }
    memoria = {
      metric      = "FreeableMemory"
      statistic   = "Minimum"
      operator    = "LessThanThreshold"
      threshold   = var.rds_freeable_memory_threshold_bytes
      description = "Memória livre do RDS baixa por 15 min."
    }
    conexoes = {
      metric      = "DatabaseConnections"
      statistic   = "Maximum"
      operator    = "GreaterThanThreshold"
      threshold   = var.rds_connections_threshold
      description = "Conexões no RDS acima de 80% do máximo da classe."
    }
  }

  alarm_name          = "${var.name}-rds-${each.key}"
  alarm_description   = each.value.description
  namespace           = "AWS/RDS"
  metric_name         = each.value.metric
  statistic           = each.value.statistic
  period              = 300
  evaluation_periods  = 3
  comparison_operator = each.value.operator
  threshold           = each.value.threshold
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions

  dimensions = {
    DBInstanceIdentifier = var.rds_identifier
  }
}

# --- Valkey ---

resource "aws_cloudwatch_metric_alarm" "valkey_memory" {
  alarm_name          = "${var.name}-valkey-memoria"
  alarm_description   = "Memória do Valkey acima de 80% por 15 min."
  namespace           = "AWS/ElastiCache"
  metric_name         = "DatabaseMemoryUsagePercentage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  comparison_operator = "GreaterThanThreshold"
  threshold           = 80
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions

  dimensions = {
    CacheClusterId = var.valkey_cache_cluster_id
  }
}

resource "aws_cloudwatch_metric_alarm" "valkey_evictions" {
  alarm_name          = "${var.name}-valkey-evictions"
  alarm_description   = "O Valkey começou a descartar chaves por falta de memória (tokens de proximidade e rate limit em risco)."
  namespace           = "AWS/ElastiCache"
  metric_name         = "Evictions"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions

  dimensions = {
    CacheClusterId = var.valkey_cache_cluster_id
  }
}

# --- Filas ---

resource "aws_cloudwatch_metric_alarm" "dlq" {
  for_each = var.dlq_names

  alarm_name          = "${var.name}-dlq-${each.key}"
  alarm_description   = "Mensagem na DLQ ${each.value}: um job falhou 3 vezes (ver o log do worker e o runbook)."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions

  dimensions = {
    QueueName = each.value
  }
}

resource "aws_cloudwatch_metric_alarm" "queue_age" {
  for_each = var.age_alarm_queue_names

  alarm_name          = "${var.name}-fila-parada-${each.key}"
  alarm_description   = "Mensagem esperando há mais de 5 min em ${each.value}: o worker pode estar parado."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 300
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions

  dimensions = {
    QueueName = each.value
  }
}

# --- MediaConvert ---

resource "aws_cloudwatch_metric_alarm" "mediaconvert_errors" {
  alarm_name          = "${var.name}-mediaconvert-erros"
  alarm_description   = "Job do MediaConvert terminou com erro (o reel vira failed; ver o log do worker)."
  namespace           = "AWS/MediaConvert"
  metric_name         = "JobsErroredCount"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  comparison_operator = "GreaterThanThreshold"
  threshold           = 0
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.actions
  ok_actions          = local.actions

  dimensions = {
    Queue = var.mediaconvert_queue_arn
  }
}
