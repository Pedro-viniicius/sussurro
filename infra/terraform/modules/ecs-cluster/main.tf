# Cluster ECS com os capacity providers FARGATE e FARGATE_SPOT (infra.md §6.2). O worker pode rodar
# no Spot: uma interrupção só devolve as mensagens à fila (infra.md §6.4).

resource "aws_ecs_cluster" "this" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = var.container_insights
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
    base              = 0
  }
}
