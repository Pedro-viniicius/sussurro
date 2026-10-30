// Schema do Drizzle (arquitetura.md §6). Fase 1: contas, sessões, tokens de e-mail e @ aposentados.
// Fase 2: posts, mídia, curtidas, comentários, trocas de avatar e (só schema) conexões e follows.
// Fase 3: bloqueios, denúncias e o índice da busca de criadores.
// Fase 4: pedidos de conexão (e a FK de `connections.request_id`).
// Fase 6: notificações, push tokens e tickets do Expo Push.
export * from './users.ts';
export * from './auth.ts';
export * from './social.ts';
export * from './posts.ts';
export * from './moderation.ts';
export * from './notifications.ts';
