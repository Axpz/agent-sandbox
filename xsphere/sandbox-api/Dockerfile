ARG BUN_IMAGE=oven/bun:1.3.5-slim
FROM ${BUN_IMAGE}

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

ENV NODE_ENV=production
EXPOSE 3000

USER bun
CMD ["bun", "run", "src/index.ts"]
