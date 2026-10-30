# Imagem de produção do worker (infra.md §6.4, backlog 7.6; ADR 0001: node:26-slim).
# Build a partir da RAIZ do monorepo, para ARM64 (Fargate Graviton; o sharp traz o binário arm64):
#   docker buildx build --platform linux/arm64 -f apps/worker/Dockerfile -t sussurro-worker:<sha> .

# --- build: instala só o worker e as dependências dele, compila e separa as de produção ---
FROM node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS build

ENV CI=true \
    PNPM_HOME=/pnpm \
    TURBO_TELEMETRY_DISABLED=1
ENV PATH="$PNPM_HOME:$PATH"

# O Node 26 não traz o corepack: o pnpm é instalado à parte, na versão do packageManager.
RUN npm install --global pnpm@12.13.0

WORKDIR /repo
COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@sussurro/worker..." --store-dir /pnpm/store

RUN pnpm --filter "@sussurro/worker..." run build

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @sussurro/worker deploy --prod --store-dir /pnpm/store /app

# --- runtime ---
FROM node:26.13.0-trixie-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39 AS runtime

# Bundle de CAs do RDS: a DATABASE_URL usa sslmode=verify-full, e a CA do RDS não está no Node.
ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
ADD --chmod=0444 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

USER node

# Sem porta e sem HTTP: o worker só consome filas e roda os jobs de manutenção. O ECS acompanha o
# processo (sem health check de container).
HEALTHCHECK NONE

STOPSIGNAL SIGTERM
CMD ["node", "--import", "./dist/instrument.js", "dist/main.js"]
