FROM oven/bun:latest AS base
WORKDIR /app

# Install backend dependencies
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Build backend
FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ src/
COPY tsconfig.json ./

# Build frontend — use Node for Vite 8 build (dns.promises.getDefaultResultOrder)
FROM base AS frontend-deps
WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile

FROM node:22-slim AS frontend-build
WORKDIR /app/frontend
COPY --from=frontend-deps /app/frontend/node_modules node_modules
COPY frontend/ .
RUN npx tsc -b && npx vite build

# Production
FROM base AS runtime
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/src src
COPY --from=build /app/tsconfig.json .
COPY --from=build /app/package.json .
COPY migrations/ migrations/
COPY --from=frontend-build /app/frontend/dist frontend/dist

ENV NODE_ENV=production
EXPOSE 9090

CMD ["bun", "run", "src/index.ts"]
