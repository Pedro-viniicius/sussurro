# ADR 0008: Regras de tipo de conta no banco e na aplicação

- Status: proposto · Data: 2026-10-29

## Contexto
Criador não segue nem conecta. Follow só vai de personal para creator. Conexões só existem entre contas pessoais. Essas regras precisam valer no servidor e têm testes obrigatórios na Fase 3.

## Decisão
**No banco (integridade que não depende de código):**
- `users` tem `UNIQUE (id, account_type)`.
- `follows(follower_id, follower_type DEFAULT 'personal' CHECK = 'personal', creator_id, creator_type DEFAULT 'creator' CHECK = 'creator')` com **FKs compostas** `(follower_id, follower_type)` e `(creator_id, creator_type)` → `users(id, account_type)`.
- `connections` e `connection_requests` seguem o mesmo padrão, com `*_type = 'personal'` nos dois lados, mais `CHECK (user_a_id < user_b_id)` e `CHECK (from_id <> to_id)`.
- Trigger `users_account_type_immutable` (`BEFORE UPDATE OF account_type`) lança erro. É o único trigger da v1.

**Na aplicação (mensagens claras e regras dependentes de contexto):**
- Guard `@RequireAccountType('personal')` em feed, busca, seguir, proximidade e conexões. Responde 403 `ACCOUNT_TYPE_NOT_ALLOWED`.
- `AccessPolicyService` para as regras de visibilidade (perfil, post, comentários).
- Erros de FK das tabelas acima viram 403 no filtro de exceções (defesa em profundidade, sem 500).

**Troca de tipo de conta: não permitida na v1.** Se for preciso, a pessoa cria outra conta. O tipo define o grafo inteiro (conexões ↔ seguidores), e converter exigiria decidir o que fazer com conexões, follows e posts já entregues.

## Alternativas
- **Triggers para validar follows e conexões**: funcionam, mas são lógica escondida e mais difícil de testar. A FK composta é declarativa e não tem custo extra relevante.
- **Só na aplicação**: um bug ou script de manutenção poderia gravar estado inválido. Descartado.
- **Tabelas separadas para criadores e pessoas**: complica busca, posts e auth. Descartado.

## Consequências
- Mesmo que a aplicação falhe, o banco recusa estados proibidos.
- As colunas `*_type` são redundantes (custam alguns bytes por linha) e o Drizzle precisa declarar a FK composta, o que ele suporta via `foreignKey({ columns: [...], foreignColumns: [...] })`.
- Se um dia houver troca de tipo, o trigger e a migração do grafo entram juntos, como mudança deliberada.
