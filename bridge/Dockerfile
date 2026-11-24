FROM node:22-slim

# Ferramentas que o Claude Code usa no dia a dia
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ripgrep curl jq ca-certificates tzdata \
    && rm -rf /var/lib/apt/lists/*

# Claude Code (CLI)
RUN npm install -g @anthropic-ai/claude-code

# Usuário sem privilégios: o Claude roda isolado aqui dentro
RUN useradd -m -u 1001 claude && mkdir -p /data && chown claude:claude /data

WORKDIR /app
COPY package.json server.js entrypoint.sh ./
COPY modelos ./modelos
RUN chmod +x entrypoint.sh && chown -R claude:claude /app

USER claude
ENV PORT=3000 \
    GRUPOS_DIR=/data/grupos \
    CLAUDE_CONFIG_DIR=/data/claude-config \
    DISABLE_AUTOUPDATER=1 \
    TZ=America/Sao_Paulo

EXPOSE 3000
VOLUME ["/data"]
ENTRYPOINT ["./entrypoint.sh"]
