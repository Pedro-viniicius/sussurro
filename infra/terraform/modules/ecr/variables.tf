variable "name" {
  description = "Prefixo dos repositórios (ex.: sussurro-prod → sussurro-prod/api)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "Use letras minúsculas, números e hífen."
  }
}

variable "repositories" {
  description = "Nomes curtos dos repositórios (um por imagem)."
  type        = set(string)

  validation {
    condition     = length(var.repositories) > 0 && alltrue([for r in var.repositories : can(regex("^[a-z][a-z0-9-]*$", r))])
    error_message = "Informe ao menos um nome, em letras minúsculas, números e hífen."
  }
}

variable "keep_images" {
  description = "Quantas imagens manter por repositório (as mais antigas expiram; rollback só para as que restam)."
  type        = number

  validation {
    condition     = var.keep_images >= 5 && var.keep_images <= 1000
    error_message = "Mantenha de 5 a 1000 imagens."
  }
}
