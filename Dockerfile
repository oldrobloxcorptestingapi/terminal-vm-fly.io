# ── Build stage ───────────────────────────────────────────────────────────────
# node-pty requires native compilation (node-gyp → g++ / make / python3).
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .

# ── Runtime stage ─────────────────────────────────────────────────────────────
FROM node:20-slim

# bash is the default shell for PTY sessions.
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy compiled node_modules (includes node-pty native binaries) + source.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app .

# Fly.io routes external 443 → internal 8080.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
