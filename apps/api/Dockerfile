# Imagem de produção da API (infra.md §6.4, backlog 7.6; ADR 0001: node:26-slim).
# Build a partir da RAIZ do monorepo, para ARM64 (Fargate Graviton):
#   docker buildx build --platform linux/arm64 -f apps/api/Dockerfile -t sussurro-api:<sha> .
# A mesma imagem roda a migration: `node dist/migrate.js` (task migrate, runbook).

# --- build: instala só a API e as dependências dela, compila e separa as de produção ---
FROM node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS build

ENV CI=true \
    PNPM_HOME=/pnpm \
    TURBO_TELEMETRY_DISABLED=1
ENV PATH="$PNPM_HOME:$PATH"

# O Node 26 não traz o corepack: o pnpm é instalado à parte, na versão do packageManager.
RUN npm install --global pnpm@12.13.0

WORKDIR /repo
COPY . .

# --frozen-lockfile: o lockfile é a fonte da verdade (e passa pela política de supply-chain do
# pnpm-workspace.yaml). O filtro instala só a API e os pacotes de que ela depende, não o app.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@sussurro/api..." --store-dir /pnpm/store

RUN pnpm --filter "@sussurro/api..." run build

# Só as dependências de produção, com os pacotes do workspace (shared e db, com as migrations)
# copiados para dentro de /app/node_modules. O caminho é o mesmo do estágio final.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @sussurro/api deploy --prod --store-dir /pnpm/store /app

# --- runtime: só o necessário para rodar, como usuário sem privilégio ---
FROM node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS runtime

# Bundle de CAs do RDS: a DATABASE_URL usa sslmode=verify-full, e a CA do RDS não está no Node.
ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
ADD --chmod=0444 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem

# O npm (e o yarn, se houver) não é usado em produção: sai da imagem.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Usuário "node" (uid 1000) da imagem oficial. O código fica do root e só de leitura para ele.
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

STOPSIGNAL SIGTERM
CMD ["node", "--import", "./dist/instrument.js", "dist/main.js"]
