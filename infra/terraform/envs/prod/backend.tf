# State remoto no bucket do bootstrap, com o lock nativo do S3 (use_lockfile, Terraform 1.10+; sem
# DynamoDB). O nome do bucket tem o id da conta e por isso não fica aqui: vem do backend.hcl no init
# (`terraform init -backend-config=backend.hcl`; modelo em backend.hcl.example). O CI só valida, com
# `terraform init -backend=false`.
terraform {
  backend "s3" {
    key          = "prod/terraform.tfstate"
    region       = "sa-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
