# Rede da produção (infra.md §6.1 e §6.3): VPC em 2 AZs, SEM NAT Gateway.
# - Subnets públicas: ALB e tasks do Fargate com IP público. A entrada nas tasks é controlada só
#   pelos security groups (a API aceita apenas o ALB; o worker e as tasks avulsas não aceitam nada).
# - Subnets privadas isoladas: RDS e Valkey, sem nenhuma rota para a internet.
# - S3 gateway endpoint (grátis) nas duas tabelas de rota.

data "aws_region" "current" {}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = var.name
  }
}

# O security group padrão da VPC fica sem nenhuma regra: cada peça usa o seu.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name}-default-sem-regras"
  }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = var.name
  }
}

resource "aws_subnet" "public" {
  count = length(var.availability_zones)

  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = cidrsubnet(var.cidr_block, 8, count.index)
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name}-public-${var.availability_zones[count.index]}"
    Tier = "public"
  }
}

resource "aws_subnet" "private" {
  count = length(var.availability_zones)

  vpc_id                  = aws_vpc.this.id
  availability_zone       = var.availability_zones[count.index]
  cidr_block              = cidrsubnet(var.cidr_block, 8, count.index + 10)
  map_public_ip_on_launch = false

  tags = {
    Name = "${var.name}-private-${var.availability_zones[count.index]}"
    Tier = "private-isolada"
  }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = {
    Name = "${var.name}-public"
  }
}

resource "aws_route_table_association" "public" {
  count = length(var.availability_zones)

  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Sem rota 0.0.0.0/0: banco e cache não alcançam nem são alcançados pela internet.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name = "${var.name}-private-isolada"
  }
}

resource "aws_route_table_association" "private" {
  count = length(var.availability_zones)

  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.this.id
  service_name      = "com.amazonaws.${data.aws_region.current.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.public.id, aws_route_table.private.id]

  tags = {
    Name = "${var.name}-s3"
  }
}

# --- Security groups (as descrições da AWS aceitam só ASCII) ---

resource "aws_security_group" "alb" {
  name        = "${var.name}-alb"
  description = "ALB publico: HTTPS (e HTTP so para redirecionar) vindo da internet"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name}-alb"
  }
}

resource "aws_security_group" "api" {
  name        = "${var.name}-api"
  description = "Tasks da API: entrada so do ALB; saida HTTPS, Postgres e Valkey"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name}-api"
  }
}

resource "aws_security_group" "worker" {
  name        = "${var.name}-worker"
  description = "Tasks do worker: sem entrada; saida HTTPS, Postgres e Valkey"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name}-worker"
  }
}

resource "aws_security_group" "ops" {
  name        = "${var.name}-ops"
  description = "Tasks avulsas (migration e criacao dos usuarios do banco): sem entrada"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name}-ops"
  }
}

resource "aws_security_group" "rds" {
  name        = "${var.name}-rds"
  description = "RDS PostgreSQL: entrada 5432 so da API, do worker e das tasks avulsas"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name}-rds"
  }
}

resource "aws_security_group" "valkey" {
  name        = "${var.name}-valkey"
  description = "ElastiCache Valkey: entrada 6379 so da API e do worker"
  vpc_id      = aws_vpc.this.id

  tags = {
    Name = "${var.name}-valkey"
  }
}

# ALB: a API é pública por definição (api.<domínio>). Só 443 e o 80 que redireciona para 443.
#trivy:ignore:AVD-AWS-0107
resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS da internet"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

#trivy:ignore:AVD-AWS-0107
resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP da internet, so para o redirect 301 para HTTPS"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "alb_to_api" {
  security_group_id            = aws_security_group.alb.id
  description                  = "Encaminha para as tasks da API"
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  referenced_security_group_id = aws_security_group.api.id
}

resource "aws_vpc_security_group_ingress_rule" "api_from_alb" {
  security_group_id            = aws_security_group.api.id
  description                  = "So o ALB fala com a API"
  ip_protocol                  = "tcp"
  from_port                    = var.api_port
  to_port                      = var.api_port
  referenced_security_group_id = aws_security_group.alb.id
}

# Saída HTTPS das tasks: APIs da AWS (ECR, Logs, SQS, S3, SES, Secrets Manager/SSM, MediaConvert),
# Expo Push e Sentry. Sem NAT nem interface endpoints (infra.md §6.3), o destino é a internet.
#trivy:ignore:AVD-AWS-0104
resource "aws_vpc_security_group_egress_rule" "https" {
  for_each = {
    api    = aws_security_group.api.id
    worker = aws_security_group.worker.id
    ops    = aws_security_group.ops.id
  }

  security_group_id = each.value
  description       = "HTTPS para APIs da AWS, Expo Push e Sentry"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "postgres" {
  for_each = {
    api    = aws_security_group.api.id
    worker = aws_security_group.worker.id
    ops    = aws_security_group.ops.id
  }

  security_group_id            = each.value
  description                  = "PostgreSQL no RDS"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.rds.id
}

resource "aws_vpc_security_group_egress_rule" "valkey" {
  for_each = {
    api    = aws_security_group.api.id
    worker = aws_security_group.worker.id
  }

  security_group_id            = each.value
  description                  = "Valkey (TLS) no ElastiCache"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = aws_security_group.valkey.id
}

resource "aws_vpc_security_group_ingress_rule" "rds" {
  for_each = {
    api    = aws_security_group.api.id
    worker = aws_security_group.worker.id
    ops    = aws_security_group.ops.id
  }

  security_group_id            = aws_security_group.rds.id
  description                  = "PostgreSQL a partir de ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = each.value
}

resource "aws_vpc_security_group_ingress_rule" "valkey" {
  for_each = {
    api    = aws_security_group.api.id
    worker = aws_security_group.worker.id
  }

  security_group_id            = aws_security_group.valkey.id
  description                  = "Valkey a partir de ${each.key}"
  ip_protocol                  = "tcp"
  from_port                    = 6379
  to_port                      = 6379
  referenced_security_group_id = each.value
}
