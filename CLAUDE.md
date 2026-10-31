# Sussurro

Rede social sem algoritmo: app Expo/React Native e API + worker NestJS, em monorepo pnpm/Turborepo.

> Em 2026-10-29 o PO aprovou o plano e autorizou executar as fases em sequência, sem parada intermediária para aprovação (`docs/equipe/PROJETO.md`, topo). As Fases 0 a 7 foram implementadas em 2026-10-30.
> - **Estado atual:** a seção "Estado das fases" do `README.md`.
> - **Git:** os PRs #1 (Fases 0 a 7) e #2 (encostar, ADR 0012) já estão na `main`. A branch `feat/denunciar-bloqueado` (Fase 4d: R1-PO-1 e adendo A3) tem PR aberto para a `main` (remoto `origin` = `Pedro-viniicius/sussurro`). Commit e push só com pedido explícito do PO.
> - **Ambiente:** Docker/WSL2 ainda não estão instalados, então `pnpm test:e2e` só roda no modo PGlite (`TEST_DB=pglite`), de forma direcionada.
> - **Abra o Claude Code em `C:\dev\sussurro`**: só assim este arquivo e os agentes de `.claude/agents/` são carregados.

## Equipe e fluxo de trabalho (desde 2026-10-30)

O **Tech Lead** é a sessão principal do Claude Code, porque subagente não chama subagente. Ele:
- recebe o pedido do PO e divide por área;
- delega a tarefa a cada agente;
- garante que dois agentes nunca editem os mesmos arquivos;
- consolida o resultado e é o único que fala com o PO.

Os agentes ficam em `.claude/agents/`. Cada um só escreve nas suas pastas, mas pode ler qualquer uma.

| Agente | Responsabilidade | Pastas (escrita) |
|---|---|---|
| 🎯 Tech Lead (sessão principal) | Divide, delega, confere e fala com o PO | `CLAUDE.md`, `README.md`, `docs/equipe/PROJETO.md`, `docs/equipe/backlog.md` |
| 💻 `frontend` | Telas, componentes, estado do cliente, recursos nativos, acessibilidade | `apps/mobile/**` (menos `eas.json` e `src/test-utils`), `packages/ui/**` (menos `src/test-utils`) |
| ⚙️ `backend` | API, worker, regras de negócio e de permissão, integrações, contratos | `apps/api/src/**` e `apps/worker/src/**` (menos repositories, `common/db` e `testing/`), `packages/shared/**` |
| 🗄️ `dados` | Schema, migrations, seed, consultas, índices, performance | `packages/db/**`, `apps/api/src/**/*.repository.ts`, `apps/api/src/common/db/**`; revisa o SQL do worker |
| 🧪 `testes` | Bateria, integração, e2e, regressão, cobertura, mutação; veredito de qualidade | `apps/*/test/**`, `apps/*/src/testing/**`, `**/test-utils/**`, configs de teste, `docs/equipe/testes.md` e arquivos de teste em qualquer área |
| 🔒 `seguranca` | Revisa todo diff; classifica em CRÍTICO, ALTO, MÉDIO e BAIXO; **veto** em CRÍTICO e ALTO | nenhuma (não edita) |
| ☁️ `devops` | Terraform (só código), CI, Docker, EAS, ferramentas da raiz | `infra/**`, `.github/**`, Dockerfiles, `docker-compose.yml`, `apps/mobile/eas.json`, `docs/deploy/**`, `docs/equipe/infra.md`, `packages/config/**`, `scripts/**`, configs da raiz |
| 🏛️ `arquiteto` (consultivo) | ADRs e decisões que cruzam áreas | `docs/equipe/arquitetura.md`, `docs/equipe/adr/**` |
| 🎨 `ux-ui` (consultivo) | Especifica e revisa telas, acessibilidade e textos | `docs/equipe/ux.md`, `docs/design/**` (o protótipo é só leitura) |

### Fluxo de cada tarefa
1. **Tech Lead:** divide a tarefa por área.
   - Quando ela cruza áreas, o contrato em `packages/shared` (`backend`) vem primeiro, e a ordem segue dados → backend → frontend.
   - No máximo 2 agentes rodam ao mesmo tempo, e só com pastas disjuntas.
2. **DEV(s):** implementam com testes unitários e documentam o que mudou e por quê.
3. **`testes`:**
   - roda a bateria das áreas tocadas;
   - escreve integração, e2e e regressão;
   - faz mutação nas regras críticas;
   - dá o veredito. Reprovado volta ao DEV.
4. **`seguranca`:** revisa o diff inteiro.
   - CRÍTICO ou ALTO é **veto**: a tarefa volta ao DEV dono.
   - MÉDIO e BAIXO ficam registrados, e o Tech Lead decide com o PO.
   - Diff com SQL fora das pastas de `dados` passa também por `dados`. Tela nova passa também por `ux-ui`.
5. **Tech Lead:** reconfere com os comandos abaixo, atualiza o README e os docs e apresenta ao PO.

### Regras da equipe
- Mudança que cruza áreas (`packages/shared`, `package.json` da raiz, uma pasta de outro agente) passa pelo Tech Lead, que a repassa ao dono.
- Dependência nova precisa do aval do Tech Lead e do `seguranca`. Só pacotes pelo pnpm, respeitando a política de supply-chain do lockfile; binários externos não são baixados.
- Sem confirmação explícita do PO, nenhum agente faz:
  - commit, push ou deploy;
  - `terraform apply`;
  - build ou submit do EAS;
  - ação destrutiva: apagar arquivos, dropar tabelas, migration destrutiva.
- Cada agente termina com um relatório curto: o que mudou e por quê, os arquivos, os comandos com o resultado real e as pendências.

### Comandos de verificação (a máquina tem pouca memória: um por vez)
- `pnpm format:check`
- `pnpm turbo run lint typecheck --concurrency=1 --force`
- `pnpm turbo run test --concurrency=1 --force -- --maxWorkers=2`
  - Um pacote só: `pnpm --filter @sussurro/mobile test --maxWorkers=2`, **sem** o `--`. Com o `--`, o pnpm repassa o separador ao Jest (app e ui), que responde "No tests found" e sai com 0: um verde falso. No Vitest (api, worker, shared e db), as duas formas funcionam.
- `pnpm build --concurrency=1 --force`
- E2E direcionado: `cd apps/api && TEST_DB=pglite pnpm exec vitest run -c vitest.e2e.config.ts --maxWorkers=1 test/e2e/<arquivos>`. No worker e no db, use `vitest.int.config.ts`.
- `npx expo-doctor` em `apps/mobile`.
- No Git Bash, o Node não está no PATH: `export PATH="/c/Program Files/nodejs:/c/Users/yasmi/AppData/Roaming/npm:$PATH"`.
- O `pnpm check -- --concurrency=1` falha, porque repassa a flag ao `tsc`. O `pnpm test:e2e` completo só roda com pedido do PO.

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
- **Emulação local:** ElasticMQ + SeaweedFS (D2).
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
