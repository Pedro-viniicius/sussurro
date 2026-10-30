variable "name" {
  description = "Nome do cluster (ex.: sussurro-prod)."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,30}$", var.name))
    error_message = "Use letras minúsculas, números e hífen."
  }
}

variable "container_insights" {
  description = "Container Insights do CloudWatch: disabled (padrão, sem custo extra), enabled ou enhanced."
  type        = string
  default     = "disabled"

  validation {
    condition     = contains(["disabled", "enabled", "enhanced"], var.container_insights)
    error_message = "Use disabled, enabled ou enhanced."
  }
}
