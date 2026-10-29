# syntax=docker/dockerfile:1.7
# One image for the SkyDra application: the API serves the built web app from the same origin.
# The same image runs the migration job (node dist/database/migrate.js) and the demo seed.

FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @skydra/shared build \
 && pnpm --filter @skydra/web build \
 && pnpm --filter @skydra/api build \
 && pnpm --filter @skydra/api deploy --prod --legacy /out \
 && cp -r apps/api/dist apps/api/migrations /out/ \
 && cp -r apps/web/dist /out/web

FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=8080 WEB_DIST_DIR=/app/web
WORKDIR /app
COPY --from=build --chown=root:root /out ./
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
