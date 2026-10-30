# Repositórios das imagens da API e do worker (infra.md §6.2): tags imutáveis (a tag é o SHA do
# git), varredura na entrada e expiração das imagens mais antigas.

resource "aws_ecr_repository" "this" {
  for_each = var.repositories

  name                 = "${var.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Mantem so as ${var.keep_images} imagens mais recentes"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = var.keep_images
        }
        action = {
          type = "expire"
        }
      },
    ]
  })
}
