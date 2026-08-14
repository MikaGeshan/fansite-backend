FROM oven/bun:1-slim

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

EXPOSE 8080

CMD ["bun", "run", "start"]
