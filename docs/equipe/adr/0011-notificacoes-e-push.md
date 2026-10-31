# ADR 0011: Notificações no app, agregação anônima e push

- Status: ~~proposto~~ Aceita (PO, 2026-10-29) · Data: 2026-10-29
- (revisto em 2026-10-31) Status atualizado: o PO aprovou o plano em 2026-10-29, e as recomendações da §8 do `PROJETO.md` passaram a valer como decididas (`PROJETO.md`, topo).

## Contexto
As notificações funcionam como nas redes comuns (curtida, comentário, resposta). Para criadores, novos seguidores aparecem agregados e anônimos ("2 novas pessoas começaram a seguir você"). O push usa o Expo.

## Decisão
- Uma tabela `notifications` (modelo em `arquitetura.md` §6), gravada **na mesma transação** do evento de origem.
- **Seguidores**: upsert por `(recipient_id, bucket_key = 'nf:'+dia em America/Sao_Paulo)` com `count = count + 1`, `read_at = NULL` e `actor_id` sempre NULL (garantido por `CHECK`). O payload nunca guarda ids de quem seguiu. Deixar de seguir não decrementa. O rate limit de follow/unfollow por par evita inflar o número.
- **Curtidas**: uma notificação por (ator, post) via índice único parcial, o que evita spam de curtir/descurtir. Não há agregação de curtidas na v1.
- **Tipos v1**: `post_liked`, `post_commented`, `comment_replied`, `new_followers`, `connection_created`.
- **Push**: depois do commit, a API envia uma mensagem para a fila `push` (com DLQ). O worker envia em lotes de 100 com `expo-server-sdk`, consulta os recibos e desativa `push_tokens` com `DeviceNotRegistered`. O texto do push é curto e não traz a íntegra do comentário. Sem preferências por tipo na v1 (o controle é o do sistema operacional).
- Leitura: `GET /notifications` (cursor por `updated_at`), `GET /notifications/unread-count` (ponto azul) e `POST /notifications/read {upTo}`.
- Retenção: 90 dias.

## Alternativas
- **Agregação no momento da leitura** (agrupar follows por dia): exigiria guardar eventos de follow individuais com ids de seguidores ligados a notificações, o que atrapalha o anonimato. O upsert é mais simples.
- **Outbox transacional** para o push: garante a entrega mesmo se o envio à fila falhar depois do commit. Na v1 basta logar a falha, porque o push é best-effort e a notificação já está no banco. O outbox entra se a perda for medida.
- **Envio de push direto da API**: acopla a latência da requisição ao Expo. Descartado.

## Consequências
- O criador nunca sabe quem o seguiu, nem pela API.
- Uma notificação "+N" pode contar a mesma pessoa duas vezes se ela seguir, deixar de seguir e seguir de novo no mesmo dia. Aceitável.
