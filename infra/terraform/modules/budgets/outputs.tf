output "budget_names" {
  description = "Orçamentos criados."
  value       = [aws_budgets_budget.monthly.name, aws_budgets_budget.media.name]
}
