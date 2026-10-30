# State do próprio bootstrap. O primeiro apply roda com o state LOCAL (o bucket ainda não existe).
# Depois dele, descomente o bloco abaixo, preencha o bucket (saída state_bucket_name) e rode
# `terraform init -migrate-state` para levar o state para o S3 (docs/deploy/runbook.md, passo 1).
# O lock é o nativo do S3 (use_lockfile, Terraform 1.10+): sem DynamoDB.
#
# terraform {
#   backend "s3" {
#     bucket       = "sussurro-tfstate-<id-da-conta>"
#     key          = "bootstrap/terraform.tfstate"
#     region       = "sa-east-1"
#     encrypt      = true
#     use_lockfile = true
#   }
# }
