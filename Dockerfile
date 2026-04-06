FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Build
FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY src/ src/
COPY tsconfig.json ./

# Production
FROM base AS runtime
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/src src
COPY --from=build /app/tsconfig.json .
COPY --from=build /app/package.json .
COPY migrations/ migrations/

ENV NODE_ENV=production
EXPOSE 9090

CMD ["bun", "run", "src/index.ts"]
