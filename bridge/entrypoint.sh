#!/bin/sh
set -e

mkdir -p "$GRUPOS_DIR" "$CLAUDE_CONFIG_DIR"

# Primeira subida: copia os grupos de exemplo para o volume.
# Grupos que já existem no volume nunca são sobrescritos.
for modelo in /app/modelos/grupos/*/; do
  nome=$(basename "$modelo")
  if [ ! -d "$GRUPOS_DIR/$nome" ]; then
    cp -r "$modelo" "$GRUPOS_DIR/$nome"
    echo "grupo de exemplo criado: $nome"
  fi
done

# Pula a tela de boas-vindas do Claude Code (não existe em modo -p, mas evita surpresas)
if [ ! -f "$CLAUDE_CONFIG_DIR/.claude.json" ]; then
  echo '{"hasCompletedOnboarding": true}' > "$CLAUDE_CONFIG_DIR/.claude.json"
fi

exec node /app/server.js
