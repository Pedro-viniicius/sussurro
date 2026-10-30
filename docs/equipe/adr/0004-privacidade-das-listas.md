# ADR 0004: Privacidade das listas de conexões e seguidos

- Status: proposto · Data: 2026-10-29

## Contexto
A especificação diz que só os **números** de conexões e de criadores seguidos são públicos e que as listas nunca saem pela API para ninguém além do dono. Uma regra assim costuma vazar por um DTO que serializa uma relação a mais, por um endpoint com `:userId` ou por log/Sentry.

## Decisão
Defesa em camadas:
1. **Rotas**: as listas existem apenas como `GET /me/connections` e `GET /me/following`, escopadas pelo `sub` do JWT. **Não existe rota que receba id ou @ de terceiro e devolva relacionamentos.** Seguidores de criador não têm lista nem para o próprio criador (só o número, que também é anônimo nas notificações).
2. **Repositório**: as funções de listagem recebem `AuthContext`, não `userId` (ex.: `listMyConnections(auth)`). Uma regra de lint/arquitetura (`dependency-cruiser` ou `no-restricted-imports`) só permite importá-las no `MeController`.
3. **Respostas filtradas por schema**: toda rota declara o schema Zod de resposta (`packages/shared`). Um interceptor global faz `schema.parse()` na saída, descarta campos não declarados e **falha fechado** (500 + Sentry) se a rota não declarar schema. O `PublicProfile` só tem `counts: {posts, connections, creators}` ou `{posts, followers}`.
4. **Contadores**: `COUNT(*)` na leitura para os números de perfil (index-only scan), com cache de 60 s para seguidores de criador. `like_count`/`comment_count` são desnormalizados em `posts`, na mesma transação, porque aparecem em todos os itens do feed.
5. **Curtidas**: nenhuma rota lista quem curtiu. Só `likeCount` e `likedByMe`.
6. **Observabilidade**: logs não incluem corpos de resposta. O Sentry tem `beforeSend` que remove campos de relacionamento.
7. **Testes**:
   - unitários do `AccessPolicyService`;
   - **teste canário e2e**: um seed cria um usuário Y com conexão e follow cujos @ são únicos (`canary_conn_*`, `canary_creator_*`). Um teste enumera todas as rotas GET registradas (via `DiscoveryService`), chama cada uma como X (conexão de Y, desconhecido e criador) e verifica que nenhum corpo contém os canários. Toda rota nova entra no teste automaticamente.
   - teste de snapshot dos schemas de resposta públicos.

## Alternativas
- **Contadores desnormalizados em `users`**: leitura O(1), mas sujeitos a drift e exigem reconciliação. Desnecessário no volume da v1 (risco R5 em `arquitetura.md`).
- **`class-transformer` com `@Exclude`**: é opt-out, e esquecer um decorador vaza dados. O whitelist por Zod é opt-in.
- **Row-level security no Postgres**: protege no banco, mas complica o Drizzle e o pool de conexões. Excessivo para a v1.

## Consequências
- Rotas novas não vazam listas por padrão, e o teste canário pega regressões.
- Vazamento indireto continua possível: um comentário de C no post de A revela a outras conexões de A que C provavelmente é conexão de A. Isso é inerente a comentários visíveis. Opções para o PO: aceitar (como nas redes comuns) ou mostrar comentários apenas ao autor do post e a quem comentou.
