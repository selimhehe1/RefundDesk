# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:24.18.0-bookworm-slim

FROM ${NODE_IMAGE} AS runtime-base
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*
ENV TZ=UTC

FROM runtime-base AS build
ENV CI=1
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:${PATH}
WORKDIR /workspace
RUN corepack enable \
    && corepack prepare pnpm@11.17.0 --activate \
    && test "$(node --version)" = "v24.18.0" \
    && test "$(pnpm --version)" = "11.17.0"
COPY . .
RUN --mount=type=cache,id=refunddesk-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm -r \
    --filter="@refunddesk/platform..." \
    --filter="@refunddesk/worker..." \
    run build
RUN pnpm --filter=@refunddesk/worker --prod deploy --legacy /out/worker

FROM build AS migrate-pruned
RUN --mount=type=cache,id=refunddesk-pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile --ignore-scripts

FROM runtime-base AS web
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /workspace/apps/platform/.next/standalone/ ./
COPY --from=build --chown=node:node \
    /workspace/apps/platform/.next/static ./apps/platform/.next/static
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const port=process.env.PORT||'3000';fetch('http://127.0.0.1:'+port+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "apps/platform/server.js"]

FROM runtime-base AS worker
ENV NODE_ENV=production
ENV WORKER_HEALTH_HOST=127.0.0.1
ENV WORKER_HEALTH_PORT=3101
WORKDIR /app
COPY --from=build --chown=node:node /out/worker/ ./
USER node
EXPOSE 3101
ENTRYPOINT ["/usr/bin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "const port=process.env.WORKER_HEALTH_PORT||'3101';const host=(process.env.WORKER_HEALTH_HOST||'127.0.0.1').includes(':')?'[::1]':'127.0.0.1';fetch('http://'+host+':'+port+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "--enable-source-maps", "dist/apps/worker/src/main.js"]

FROM runtime-base AS migrate
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:${PATH}
ENV COREPACK_HOME=/opt/corepack
WORKDIR /workspace
RUN mkdir -p /opt/corepack \
    && corepack enable \
    && corepack prepare pnpm@11.17.0 --activate \
    && chmod -R a+rX /opt/corepack \
    && test "$(pnpm --version)" = "11.17.0"
ENV COREPACK_ENABLE_NETWORK=0
ENV pnpm_config_verify_deps_before_run=false
COPY --from=migrate-pruned --chown=node:node /workspace/node_modules ./node_modules
COPY --from=migrate-pruned --chown=node:node /workspace/package.json ./
COPY --from=migrate-pruned --chown=node:node /workspace/pnpm-lock.yaml ./
COPY --from=migrate-pruned --chown=node:node /workspace/pnpm-workspace.yaml ./
COPY --from=migrate-pruned --chown=node:node /workspace/scripts/database-command.mjs ./scripts/
COPY --from=migrate-pruned --chown=node:node /workspace/scripts/database-command-policy.mjs ./scripts/
COPY --from=migrate-pruned --chown=node:node /workspace/scripts/local-environment.mjs ./scripts/
COPY --from=migrate-pruned --chown=node:node /workspace/packages/config/package.json ./packages/config/
COPY --from=migrate-pruned --chown=node:node /workspace/packages/config/src ./packages/config/src
COPY --from=migrate-pruned --chown=node:node /workspace/packages/config/node_modules ./packages/config/node_modules
COPY --from=build --chown=node:node /workspace/packages/config/dist ./packages/config/dist
COPY --from=migrate-pruned --chown=node:node /workspace/packages/db/package.json ./packages/db/
COPY --from=migrate-pruned --chown=node:node /workspace/packages/db/prisma ./packages/db/prisma
COPY --from=migrate-pruned --chown=node:node /workspace/packages/db/scripts ./packages/db/scripts
COPY --from=migrate-pruned --chown=node:node /workspace/packages/db/node_modules ./packages/db/node_modules
COPY --from=migrate-pruned --chown=node:node /workspace/apps/worker/package.json ./apps/worker/
COPY --from=migrate-pruned --chown=node:node /workspace/apps/worker/scripts ./apps/worker/scripts
COPY --from=migrate-pruned --chown=node:node /workspace/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=migrate-pruned --chown=node:node /workspace/apps/migrator/package.json ./apps/migrator/
COPY --from=migrate-pruned --chown=node:node /workspace/apps/migrator/prisma.config.ts ./apps/migrator/
COPY --from=migrate-pruned --chown=node:node /workspace/apps/migrator/node_modules ./apps/migrator/node_modules
RUN chown node:node /workspace
USER node
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "scripts/database-command.mjs", "release-prepare"]

FROM web AS default
