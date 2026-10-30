# Sussurro

Rede social sem algoritmo: app Expo/React Native e API + worker NestJS, em monorepo pnpm/Turborepo.

> Em 2026-10-29 o PO aprovou o plano e autorizou executar as fases em sequência, sem parada intermediária para aprovação (`docs/equipe/PROJETO.md`, topo).
> - **Estado atual:** a seção "Estado das fases" do `README.md`.
> - **Git:** repositório iniciado, com o remoto `origin` apontando para `Pedro-viniicius/sussurro`. **Não há commit local:** nada de commit ou push sem pedido explícito.
> - **Ambiente:** Docker/WSL2 ainda não estão instalados, então `pnpm test:e2e` não roda.

## Regras do PO
- Trabalhar em **fases** (0 a 7, definidas em `docs/equipe/briefing.md` §8) e **parar ao fim de cada fase** para revisão.
- Apresentar o plano antes de escrever código. Não implementar nada fora do escopo da especificação.
- Desvios da stack definida pelo PO viram decisão do PO, com recomendação. Nunca mudar sem avisar.
- Não fazer commit sem pedido explícito. Nunca rodar `terraform apply`.
- Idioma: português do Brasil.

## Fonte da verdade
`docs/equipe/PROJETO.md` (consolidado: escopo, roadmap, riscos, decisões, DoR/DoD). Detalhes por especialidade:
- `briefing.md`: especificação original, na íntegra
- `arquitetura.md` + `adr/`
- `ux.md`: design system e telas
- `fase-0-plano.md`: árvore de pastas e convenções
- `backlog.md`: histórias e critérios de aceite
- `infra.md`: ambiente, compose, CI, EAS, AWS
- `testes.md`: estratégia, casos numerados, checklist por fase

O protótipo está em `docs/design/prototipo/`.

## Ambiente
- Windows 11 + PowerShell, com 7,7 GB de RAM.
- Node 26.13.0 LTS. Sem corepack: o pnpm 12.13.0 é instalado com `npm i -g`.
- O Docker Desktop precisa de WSL2, limitado a 3 GB.
- O iOS e o Android saem pelo EAS Build em aparelho físico (não há Mac nem emulador).

## Stack
- **App:** Expo SDK 58, Expo Router (`apps/mobile/src/app`) e TypeScript strict.
- **Back:** API e worker em NestJS 12 (ESM). PostgreSQL 18 + Drizzle (`packages/db`), Redis (Valkey), SQS e S3.
- **Emulação local:** ElasticMQ + SeaweedFS, pendente de D2.
- **Pacotes compartilhados:** contratos Zod em `packages/shared`; tema e componentes em `packages/ui`; configs base em `packages/config`.
- **Testes:** Vitest + `unplugin-swc` (API e worker); jest-expo + Testing Library (app e ui).
- **Qualidade:** ESLint flat config + Prettier.

## Comandos (a partir da Fase 0)
- `pnpm dev`: sobe a API, o worker e o watch dos pacotes. `pnpm dev:mobile`: abre o Expo (dev client).
- `pnpm check`: format, lint, typecheck e testes unitários (o mesmo que o CI roda).
- `pnpm test`: testes unitários, sem Docker.
- `pnpm test:e2e`: integração e e2e; precisa do `docker compose up -d --wait`.
- `pnpm db:generate` / `pnpm db:migrate`: a partir da Fase 1.

## Convenções
- **Commits:** Conventional Commits em pt-BR, `tipo(escopo): descrição`. Escopos: `mobile`, `api`, `worker`, `shared`, `ui`, `db`, `config`, `infra`, `docs`, `deps` e `repo`.
- **Branches:** trunk-based, com branches curtas (`feat/f0-...`), squash merge e tag `fase-N` depois da aprovação do PO.
- **Validação e erros:** validação com Zod nas bordas. Erros saem como `{code, message, details?}`.
- **Regras de permissão:** sempre no servidor, com teste. Toda rota nova entra no teste canário de privacidade (PERM-10).
- **Testes:** cada teste traz o ID do caso de `testes.md` no nome (ex.: `PERM-03`).
- **Configuração:** um `.env.example` na raiz e outro no app (`EXPO_PUBLIC_*`), sem segredos.
- Detalhes em `docs/equipe/fase-0-plano.md` §6.
