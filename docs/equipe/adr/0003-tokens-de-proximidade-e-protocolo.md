# ADR 0003: Tokens de proximidade e protocolo de conexão mútua

- Status: proposto · Data: 2026-10-29

## Contexto
A especificação pede um token opaco e efêmero (30 s, Redis), troca por BLE ou QR, pedido de A com o token de B e confirmação de B, com o servidor exigindo tokens "válidos, recentes e cruzados", mais rate limit e registro do método. Faltava definir: formato do token, o que "cruzado" exige de cada lado, entrega do pedido, corridas, replay e expiração.

## Decisão
**Token**: 12 bytes de CSPRNG (base64url, 16 caracteres). Cabe no UUID de BLE (ADR 0002) e no QR `sussurro://c/{token}`. Só contas `personal` emitem. No Redis ele é guardado como hash SHA-256:
- `prox:t:{h}` → `{uid, iat}`, TTL 30 s (**válido**, pode iniciar pedido e ser resolvido);
- `prox:r:{h}` → `uid`, TTL 120 s (**recente**, só para confirmar);
- `prox:u:{uid}`, TTL 30 s, prova de que a tela Conectar está aberta.
- O app renova o token a cada 20 s enquanto a tela está em foreground.

**Resolver**: `POST /proximity/resolve` transforma tokens válidos em `{handle, name, avatar, alreadyConnected}`, só se o chamador também tem `prox:u` ativo.

**Pedido (A→B)**: precisa do `tB` válido, do `prox:u:A` ativo, de B `personal` e diferente de A, de não estarem já conectados, de não haver cooldown e de passar no rate limit. A transação faz `pg_advisory_xact_lock(hash(par))`, expira os pendentes vencidos do par e verifica se existe pendente **B→A**. Se existir, cria a conexão na hora (os dois já observaram o token um do outro). Se não, insere o pedido com `expires_at = now + 120 s`. Um índice único parcial garante um pendente por par.

**Confirmação (B)**: `POST /connections/requests/:id/accept {observedToken: tA}` exige `prox:u:B` ativo, `tA` válido ou recente e com dono igual a `from_id`, e o pedido pendente, não expirado e endereçado a B. Insere em `connections` (`a<b`, `method` do pedido) com `ON CONFLICT DO NOTHING`. A chamada é idempotente.

**QR**: A lê o QR de B e cria o pedido. Para aceitar, B lê o QR de A, exibido na tela "Aguardando", o que mantém o cruzamento.

**Entrega**: polling de 2 s com a tela aberta (`GET /connections/requests/incoming` e `GET /connections/requests/:id`). Push entra na Fase 6.

**Recusa**: cooldown de 1 h A→B. A vê "não confirmado", igual à expiração.

**Rate limits por usuário**: tokens 6/min, resolve 30/min, pedidos 10/min e 50/dia, aceites 10/min, 20 falhas de token em 10 min bloqueiam por 15 min. Se o Redis cair, a proximidade fica fail-closed.

## Alternativas
- **Token JWT/HMAC sem Redis**: verificável sem estado, mas maior (não cabe no anúncio) e não revogável. Descartado.
- **Token de uso único**: impediria várias pessoas próximas de verem a mesma pessoa. A proteção contra uso repetido fica no par único pendente e no aceite idempotente.
- **Servidor repassa tA para B** (B não observa nada): o "cruzado" perde o sentido e o ataque de relay remoto fica possível. Descartado.
- **QR de mão única** (B só aceita): fluxo mais simples, com garantia menor. Decisão do PO.
- **WebSocket/SSE para o pedido**: menor latência, mais infraestrutura. Fica para quando o polling for medido como problema.

## Consequências
- A garantia de presença vem de os dois lados terem observado o token do outro em até 120 s e de os dois estarem com a tela aberta.
- O ataque de relay ativo nos dois sentidos continua teoricamente possível. Ele é mitigado pelo aceite explícito com nome e avatar visíveis.
- Testes obrigatórios (Fase 4): token expirado, token de outro dono, criador tentando, pedidos simultâneos (A→B ∥ B→A), aceite duplo, aceite após expiração, cooldown, rate limit e replay de `observedToken` em outro pedido.
