# ADR 0001: Monorepo, toolchain e versão do Node

- Status: proposto · Data: 2026-10-29

## Contexto
O PO fixou pnpm workspaces + Turborepo, Expo (dev build) e NestJS. A máquina do PO é Windows 11 com Node v26.13.0. O iOS é buildado pelo EAS (sem Mac). Fatos verificados em 2026-10-29:
- Node 26 entrou em **Active LTS em 2026-10-28**, com fim de vida em abr/2029. Ele é a última versão no modelo par/ímpar. A partir do Node 27 todo major vira LTS.
- Expo SDK 58 (RN 0.88, React 19.3) é o SDK atual e pede Node >= 22.13. O Expo suporta instalações isoladas de dependências desde o SDK 54, e a partir do SDK 55 o Metro se configura sozinho em monorepo.
- `@nestjs/core` 12.x tem `engines.node >= 20`.
- pnpm 12.x e Turborepo 2.x são as versões estáveis atuais.

## Decisão
1. **Node 26 LTS** em todos os lugares: `.nvmrc` = `26`, `engines.node` = `">=26.13 <27"` com `engine-strict`, imagem `node:26-slim` nos Dockerfiles, `"node": "26.13.0"` nos perfis do `eas.json` e `actions/setup-node` lendo o `.nvmrc`.
2. `packageManager: "pnpm@12.13.0"` no `package.json` raiz. **Corrigido na consolidação:** o Node 26 não traz o corepack (removido a partir do Node 25), então o pnpm é instalado à parte (`npm i -g pnpm@12.13.0`) e, no CI, por `pnpm/action-setup` (ver `infra.md` §1.2).
3. pnpm com **`nodeLinker: isolated`** (padrão). Fallback documentado: `nodeLinker: hoisted` no `pnpm-workspace.yaml` se alguma lib nativa de RN falhar no autolinking. Sem configuração manual de Metro (`watchFolders` etc.).
4. Expo **SDK 58**, com fallback para o SDK 57.
5. Pacotes além do briefing: `packages/db` (schema Drizzle e migrations, usados pela API e pelo worker) e `packages/config` (tsconfig/eslint/prettier base).
6. **Portão da Fase 0**: smoke test no Windows com Node 26 (`pnpm install`, `expo start`, `expo prebuild --platform android`, build EAS de desenvolvimento, `nest build`, vitest, instalação de `sharp` e `@node-rs/argon2`). Se algo falhar sem correção simples, voltamos para o Node 24 LTS, o que muda só `.nvmrc`, `engines`, `eas.json` e o Dockerfile.

## Alternativas
- **Node 24 LTS** (maintenance desde out/2026, EOL abr/2028): é mais testado pelo ecossistema hoje. Fica como fallback. Escolher o 24 agora obrigaria a migrar daqui a 18 meses e criaria divergência com a máquina do PO.
- **Node 22**: EOL em abr/2027, curto demais.
- **`hoisted` desde o início**: é mais compatível com libs RN antigas, mas perde a garantia de dependências declaradas. Como o módulo BLE é nosso (ADR 0002) e o resto são libs Expo, `isolated` é viável.
- **Nx**: mais poderoso, mas o PO fixou Turborepo e o caso não exige mais.

## Consequências
- O ambiente é reprodutível: CI, EAS, Docker e máquina local usam o mesmo major.
- O risco de adotar o Node 26 cedo é coberto pelo portão da Fase 0 e por uma reversão barata.
- No Windows é preciso habilitar caminhos longos (`git config core.longpaths true` e a política LongPathsEnabled) por causa do Gradle e do `node_modules` isolado.
