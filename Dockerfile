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

# Install bash + common tools + deps needed by Nix
RUN apt-get update && apt-get install -y --no-install-recommends \
      bash curl git wget vim nano unzip ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Install Nix (single-user, no daemon — works fine in Docker)
RUN curl -L https://nixos.org/nix/install | sh -s -- --no-daemon

# Make nix available to all bash sessions (PTY shells will source this)
ENV NIX_PROFILES="/nix/var/nix/profiles/default /root/.nix-profile"
ENV PATH="/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:$PATH"
ENV NIX_SSL_CERT_FILE="/etc/ssl/certs/ca-certificates.crt"

# Source nix in every interactive bash session so nix-shell works immediately
RUN echo '. /root/.nix-profile/etc/profile.d/nix.sh' >> /root/.bashrc

# Install opencode globally (npm package name is opencode-ai)
RUN npm install -g opencode-ai

WORKDIR /app

# Copy compiled node_modules (includes node-pty native binaries) + source.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app .

# Fly.io routes external 443 → internal 8080.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
