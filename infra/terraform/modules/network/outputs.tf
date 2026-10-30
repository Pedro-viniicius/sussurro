output "vpc_id" {
  description = "Id da VPC."
  value       = aws_vpc.this.id
}

output "public_subnet_ids" {
  description = "Subnets públicas (ALB e tasks do Fargate, com IP público)."
  value       = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  description = "Subnets privadas isoladas (RDS e Valkey), sem rota para a internet."
  value       = aws_subnet.private[*].id
}

output "security_group_ids" {
  description = "Security groups por papel: alb, api, worker, ops, rds e valkey."
  value = {
    alb    = aws_security_group.alb.id
    api    = aws_security_group.api.id
    worker = aws_security_group.worker.id
    ops    = aws_security_group.ops.id
    rds    = aws_security_group.rds.id
    valkey = aws_security_group.valkey.id
  }
}
