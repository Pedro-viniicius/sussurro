# E-mail transacional pelo SES (D6: confirmação de e-mail, redefinição de senha e a fila de
# moderação). Identidade de domínio com Easy DKIM de 2048 bits. A saída do sandbox do SES é um
# pedido manual à AWS (runbook).

resource "aws_sesv2_email_identity" "this" {
  email_identity = var.domain_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}
