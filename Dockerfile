FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/taskctl/package.json packages/taskctl/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    CODEXBOARD_ENV=production \
    CODEXBOARD_HOST=0.0.0.0 \
    CODEXBOARD_PORT=47823 \
    CODEXBOARD_ADMIN_HOST=127.0.0.1 \
    CODEXBOARD_ADMIN_PORT=47824 \
    DEVBOARD_DATA_DIR=/var/lib/devboard

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssh-client \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/devboard/ssh /tmp \
  && chown -R node:node /var/lib/devboard \
  && chmod 1777 /tmp
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/packages/contracts/package.json ./packages/contracts/package.json
COPY --from=build --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist

USER node
VOLUME ["/var/lib/devboard"]
EXPOSE 47823
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:47823/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "apps/server/dist/main.js"]
