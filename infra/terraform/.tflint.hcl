# TFLint (CI, job infra; infra.md §4.2): preset recomendado + regras de documentação e de estrutura,
# e o ruleset da AWS sem deep check (o CI não tem credenciais).
# Rodar a partir da raiz do repositório:
#   tflint --chdir=infra/terraform --init --config="$PWD/infra/terraform/.tflint.hcl"
#   tflint --chdir=infra/terraform --recursive --config="$PWD/infra/terraform/.tflint.hcl"

config {
  call_module_type = "local"
}

plugin "terraform" {
  enabled = true
  preset  = "recommended"
}

plugin "aws" {
  enabled = true
  version = "0.49.0"
  source  = "github.com/terraform-linters/tflint-ruleset-aws"
}

rule "terraform_documented_variables" {
  enabled = true
}

rule "terraform_documented_outputs" {
  enabled = true
}

rule "terraform_naming_convention" {
  enabled = true
}

rule "terraform_standard_module_structure" {
  enabled = true
}
