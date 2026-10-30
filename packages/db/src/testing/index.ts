// Utilitários de teste: só para testes (não entram no build nem no código de produção).
export * from './factories.ts';
export * from './test-database.ts';
// Seed das personas (Fase 3, história 3.8): os e2e de permissão rodam com as relações reais dele.
export {
  PERSONAS,
  SEED_BLOCKS,
  SEED_CONNECTIONS,
  SEED_FOLLOWS,
  SEED_REELS,
  SEED_REPORTS,
  seedDatabase,
} from '../seed/seed.ts';
