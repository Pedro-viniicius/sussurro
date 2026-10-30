# ADR 0005: Feed cronológico por janela (fan-out na leitura)

- Status: proposto · Data: 2026-10-29

## Contexto
O feed mostra posts das conexões (bidirecional, par ordenado) e dos criadores seguidos, por aba (photo/text/reel), mais novos primeiro, das últimas 72 h (configurável), e termina em "Você está em dia". Não há ranqueamento.

## Decisão
- **Fan-out na leitura**: uma query SQL com CTE de autores (conexões dos dois lados do par + follows) e `JOIN LATERAL` por autor no índice `posts (author_id, type, published_at DESC, id DESC) WHERE status='published' AND deleted_at IS NULL`. A SQL completa está em `arquitetura.md` §8.
- Ordenação por **`published_at`**, não `created_at`, porque um post de foto ou reel só entra no feed quando a mídia fica pronta.
- **Paginação por cursor** `(published_at, id)` com o `since` fixado na primeira página e carregado no cursor. O servidor limita `since` para que não fique antes de `janela + 1 h`.
- `FEED_WINDOW_HOURS` vem do ambiente, com padrão 72, e é exposto em `windowHours` na resposta para o texto "últimos 3 dias".
- Resposta `{items, nextCursor, caughtUp, windowHours}`. Limite padrão 20, máximo 50.
- Criador não tem feed (403).

## Alternativas
- **Fan-out na escrita (timeline materializada por usuário)**: leitura O(1), mas escrita O(seguidores) para criadores grandes e mais infraestrutura (fila, tabela de timeline, backfill quando se conecta). Otimização prematura para a v1.
- **Paginação por OFFSET**: instável com posts novos e mais lenta. Descartada.
- **Sem paginação, tudo de 72 h de uma vez**: payload imprevisível. Descartado.

## Consequências
- Simples, correto e sem consistência eventual: quem conecta ou segue vê os posts na hora.
- O custo cresce com o número de autores de cada leitor. Monitorar o p95. Mitigação futura: teto de follows ou timeline materializada só para criadores (risco R4).
- Testes: a janela corta exatamente, a ordem é estável com timestamps iguais (desempate por id), os dois lados do par aparecem, posts `draft/processing/deleted` não aparecem, criador recebe 403 e a última página vem com `caughtUp=true`.
