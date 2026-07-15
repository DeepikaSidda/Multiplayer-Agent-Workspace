# Multiplayer Agent Workspace — single-image build.
# Builds shared + server + client (production web bundle) and runs the Node
# server, which serves the client on one port. Bedrock auth comes from the
# environment (an EC2 IAM role in production — no static keys needed).

FROM node:20-bookworm-slim

# Build tools for native deps (better-sqlite3).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package*.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm install

# Build everything (shared -> server -> client dist-web).
COPY . .
RUN npm run build:deploy

ENV NODE_ENV=production
ENV PORT=8787
# Persist the SQLite database on a mounted volume.
ENV DB_PATH=/data/maw.db
EXPOSE 8787
VOLUME ["/data"]

CMD ["node", "server/dist/main.js"]
