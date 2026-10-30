# Serviço genérico no Fargate ARM64 (infra.md §6.2 e §6.4): log group, execution role própria (só
# os segredos e o repositório desta task), task definition e, se pedido, serviço com rolling
# update, circuit breaker com rollback automático e autoscaling por CPU.
#
# Deploy (docs/deploy/runbook.md): o Terraform registra uma revisão nova da task definition a cada
# mudança (imagem ou variáveis) e mantém as anteriores (skip_destroy), mas NÃO troca a revisão do
# serviço: quem troca é o `aws ecs update-service`, depois da migration. O rollback é voltar o
# serviço para a revisão anterior, que continua ativa.

data "aws_region" "current" {}

locals {
  # valueFrom de cada segredo: o ARN ou, para um campo de um segredo JSON, "ARN:campo::".
  secret_value_from = {
    for name, s in var.secrets : name => s.json_key == null ? s.arn : "${s.arn}:${s.json_key}::"
  }

  has_secretsmanager = anytrue([for s in values(var.secrets) : s.kind == "secretsmanager"])
  has_ssm            = anytrue([for s in values(var.secrets) : s.kind == "ssm"])
  has_ecr            = length(var.ecr_repository_arns) > 0

  container = merge(
    {
      name                   = var.container_name
      image                  = var.image
      essential              = true
      readonlyRootFilesystem = var.readonly_root_filesystem
      stopTimeout            = var.stop_timeout
      mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
      linuxParameters        = { initProcessEnabled = true }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.this.name
          awslogs-region        = data.aws_region.current.region
          awslogs-stream-prefix = var.container_name
          mode                  = "non-blocking"
          max-buffer-size       = "25m"
        }
      }
    },
    # Listas vazias ficam de fora: a API do ECS não as devolve, e o Terraform veria diferença a cada plan.
    length(var.environment) == 0 ? {} : { environment = [for k in sort(keys(var.environment)) : { name = k, value = var.environment[k] }] },
    length(var.secrets) == 0 ? {} : { secrets = [for k in sort(keys(var.secrets)) : { name = k, valueFrom = local.secret_value_from[k] }] },
    var.container_port == null ? {} : { portMappings = [{ containerPort = var.container_port, hostPort = var.container_port, protocol = "tcp" }] },
    var.entry_point == null ? {} : { entryPoint = var.entry_point },
    var.command == null ? {} : { command = var.command },
    var.user == null ? {} : { user = var.user },
  )
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name}"
  retention_in_days = var.log_retention_days
  log_group_class   = var.log_group_class
}

# --- Execution role: o agente do ECS baixa a imagem, escreve o log e lê os segredos desta task ---

data "aws_iam_policy_document" "assume_ecs_tasks" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-exec"
  description        = "Execution role de ${var.name}: imagem, log e os segredos desta task"
  assume_role_policy = data.aws_iam_policy_document.assume_ecs_tasks.json
}

# ecr:GetAuthorizationToken não aceita recurso específico (exige "*"); o pull fica restrito aos
# repositórios listados, e os logs ao log group desta task.
#trivy:ignore:AVD-AWS-0057
data "aws_iam_policy_document" "execution" {
  statement {
    sid       = "Logs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }

  dynamic "statement" {
    for_each = local.has_ecr ? [1] : []

    content {
      sid       = "EcrAuth"
      actions   = ["ecr:GetAuthorizationToken"]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = local.has_ecr ? [1] : []

    content {
      sid       = "EcrPull"
      actions   = ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"]
      resources = var.ecr_repository_arns
    }
  }

  dynamic "statement" {
    for_each = local.has_secretsmanager ? [1] : []

    content {
      sid       = "SecretsManager"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = distinct([for s in values(var.secrets) : s.arn if s.kind == "secretsmanager"])
    }
  }

  dynamic "statement" {
    for_each = local.has_ssm ? [1] : []

    content {
      sid       = "SsmParameters"
      actions   = ["ssm:GetParameters"]
      resources = distinct([for s in values(var.secrets) : s.arn if s.kind == "ssm"])
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "execution"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# --- Task definition ---

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = var.task_role_arn
  container_definitions    = jsonencode([local.container])
  skip_destroy             = true

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  volume {
    name = "tmp"
  }
}

# --- Serviço (opcional) ---

resource "aws_ecs_service" "this" {
  count = var.create_service ? 1 : 0

  name                               = var.name
  cluster                            = var.cluster_arn
  task_definition                    = aws_ecs_task_definition.this.arn
  desired_count                      = var.desired_count
  platform_version                   = "LATEST"
  enable_execute_command             = false
  propagate_tags                     = "SERVICE"
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  health_check_grace_period_seconds  = var.attach_load_balancer ? var.health_check_grace_period : null
  wait_for_steady_state              = false

  capacity_provider_strategy {
    capacity_provider = var.capacity_provider
    weight            = 1
    base              = 0
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = var.security_group_ids
    assign_public_ip = true
  }

  dynamic "load_balancer" {
    for_each = var.attach_load_balancer ? [1] : []

    content {
      target_group_arn = var.target_group_arn
      container_name   = var.container_name
      container_port   = var.container_port
    }
  }

  # A revisão da task definition é trocada pelo deploy (update-service) e a quantidade de tasks
  # pelo autoscaling: o Terraform não desfaz nenhum dos dois.
  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}

resource "aws_appautoscaling_target" "this" {
  count = var.create_service && var.autoscaling != null ? 1 : 0

  service_namespace  = "ecs"
  resource_id        = "service/${var.cluster_name}/${aws_ecs_service.this[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.autoscaling.min
  max_capacity       = var.autoscaling.max
}

resource "aws_appautoscaling_policy" "cpu" {
  count = var.create_service && var.autoscaling != null ? 1 : 0

  name               = "${var.name}-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.this[0].service_namespace
  resource_id        = aws_appautoscaling_target.this[0].resource_id
  scalable_dimension = aws_appautoscaling_target.this[0].scalable_dimension

  target_tracking_scaling_policy_configuration {
    target_value       = var.autoscaling.cpu_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60

    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}
