output "role_arn" {
  description = "Role de serviço do MediaConvert (MEDIACONVERT_ROLE_ARN do worker)."
  value       = aws_iam_role.mediaconvert.arn
}

output "rule_arn" {
  description = "ARN da regra do EventBridge (a única que pode enviar para a video-events)."
  value       = aws_cloudwatch_event_rule.job_state.arn
}
