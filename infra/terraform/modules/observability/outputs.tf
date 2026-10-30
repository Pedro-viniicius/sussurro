output "alarm_topic_arn" {
  description = "Tópico SNS dos alarmes (a inscrição por e-mail precisa ser confirmada)."
  value       = aws_sns_topic.alarms.arn
}
