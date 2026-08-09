# syntax=docker/dockerfile:1

FROM node:24.18.0-bookworm-slim AS dependencies

WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build

ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=$VITE_BASE_PATH

COPY . .
RUN npm run build \
    && npm prune --omit=dev

FROM node:24.18.0-bookworm-slim AS ai-tools

ARG AGENT_REACH_COMMIT=1221ecd0c3e0502ee37406f03543bedf7503f2c7

RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && git clone --filter=blob:none https://github.com/Panniantong/Agent-Reach.git /opt/agent-reach \
    && git -C /opt/agent-reach checkout "$AGENT_REACH_COMMIT" \
    && rm -rf /opt/agent-reach/.git \
    && python3 -m venv /opt/agent-reach-venv \
    && /opt/agent-reach-venv/bin/pip install --no-cache-dir -c /opt/agent-reach/constraints.txt /opt/agent-reach \
    && npm install --global --omit=dev mcporter@0.13.2 \
    && mkdir -p /opt/northstar-ai-home/.config/opencode/skills/agent-reach \
    && cp -R /opt/agent-reach/agent_reach/skill/. /opt/northstar-ai-home/.config/opencode/skills/agent-reach/

FROM node:24.18.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=5888 \
    HOST=0.0.0.0 \
    TZ=Asia/Shanghai \
    DATABASE_PATH=/app/data/finance.sqlite \
    PATH=/app/node_modules/.bin:/opt/agent-reach-venv/bin:$PATH

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl gh git python3 tini \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data /var/lib/northstar-ai /opt/northstar-ai-home \
    && chown node:node /app/data /var/lib/northstar-ai

COPY --from=ai-tools /opt/agent-reach /opt/agent-reach
COPY --from=ai-tools /opt/agent-reach-venv /opt/agent-reach-venv
COPY --from=ai-tools /opt/northstar-ai-home /opt/northstar-ai-home
COPY --from=ai-tools /usr/local/lib/node_modules/mcporter /usr/local/lib/node_modules/mcporter
RUN ln -s /usr/local/lib/node_modules/mcporter/dist/cli.js /usr/local/bin/mcporter \
    && ln -s /opt/agent-reach-venv/bin/agent-reach /usr/local/bin/agent-reach

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json package-lock.json tsconfig.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node shared ./shared

USER node

EXPOSE 5888
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:5888/api/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "server/index.ts"]
