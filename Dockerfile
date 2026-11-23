FROM node:24-bookworm-slim AS base
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS check
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
COPY public ./public
RUN pnpm typecheck && pnpm test && touch /checked

FROM base AS runtime
COPY --from=check /checked /checked
RUN pnpm install --frozen-lockfile --prod
COPY src ./src
COPY public ./public
ENV NODE_ENV=production DB_PATH=/db/gym-tracker.sqlite
USER node
HEALTHCHECK --interval=60s --timeout=5s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--max-old-space-size=96", "src/main.ts"]
