# Multi-stage: build deps separately so the runtime image carries no toolchain.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
COPY packages/domain/package.json packages/domain/
COPY services/api/package.json services/api/
RUN npm ci --omit=dev --workspaces --include-workspace-root || npm install --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app

# Run unprivileged. The node image ships a `node` user; use it rather than root.
RUN apk add --no-cache tini && addgroup -S app && adduser -S -G app app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=app:app package.json ./
COPY --chown=app:app packages ./packages
COPY --chown=app:app services/api ./services/api

USER app
ENV NODE_ENV=production PORT=8080
EXPOSE 8080

# tini reaps zombies and forwards SIGTERM, which is what makes the graceful
# shutdown in main.js actually fire during a rolling deploy.
ENTRYPOINT ["/sbin/tini", "--"]

# Liveness only. Readiness is checked by the orchestrator against /ready, which
# touches real dependencies.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "services/api/src/main.js"]
