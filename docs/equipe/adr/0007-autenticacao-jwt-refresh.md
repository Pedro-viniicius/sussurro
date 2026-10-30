# ADR 0007: Autenticação com JWT de acesso curto e refresh rotativo

- Status: proposto · Data: 2026-10-29

## Contexto
A Fase 1 pede e-mail e senha com JWT e refresh. O protótipo diz "E-mail ou nome de usuário" e a especificação diz e-mail. O app é mobile e não usa cookies.

## Decisão
- **Login só por e-mail na v1.** O rótulo do protótipo muda para "E-mail".
- Senha: argon2id (`@node-rs/argon2`, parâmetros OWASP), mínimo de 8 caracteres, checagem contra lista de senhas comuns.
- **Access token**: JWT HS256 com validade de 15 min, `kid` para rotação do segredo e claims `sub`, `acct` (tipo de conta, que é imutável) e `fam`. Fica só em memória no app.
- **Refresh token**: 256 bits aleatórios e opacos, guardados como SHA-256 em `refresh_tokens`, validade de 30 dias, **rotacionados a cada uso** dentro de uma família (uma por dispositivo/login).
  - Reapresentar um token já rotacionado **mais de 20 s depois** é tratado como roubo e revoga a família inteira.
  - Dentro de 20 s, é retry de rede: o servidor revoga o sucessor e emite um novo par.
- Logout revoga a família e desativa o push token do dispositivo. Também há "sair de todos" e a revogação de todas as famílias na troca de senha.
- App: refresh no `expo-secure-store` (`WHEN_UNLOCKED_THIS_DEVICE_ONLY`). O interceptor HTTP faz **single-flight** do refresh e repete a chamada original depois.
- Rate limit: login 5/min por IP+e-mail e 20/min por IP. Cadastro 5/h por IP. As mensagens de erro são genéricas.

## Alternativas
- **Login por e-mail ou @**: conveniente, mas transforma o login em oráculo de existência de @ de contas pessoais, que nunca aparecem em busca. Também exige normalizar duas chaves. Pode entrar depois sem quebrar nada.
- **Sessão opaca no Redis para tudo**: simples de revogar, mas cada requisição vai ao Redis. O JWT de 15 min com a revogação no refresh atende.
- **RS256/EdDSA**: útil quando outros serviços validam o token. No monólito, HS256 é suficiente, e migrar depois é trivial com `kid`.
- **Refresh sem rotação**: um roubo fica indetectável. Descartado.

## Consequências
- Uma conta revogada pode manter acesso por até 15 min (o tempo de vida do access token). Isso é aceitável. A exclusão de conta também invalida no guard, que checa `deleted_at` com cache curto.
- Não há "esqueci minha senha" nem verificação de e-mail na especificação. O PO precisa decidir, porque exigem envio de e-mail (SES).
