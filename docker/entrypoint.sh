#!/bin/sh
set -e

# Hugging Face Spaces provides SPACE_HOST. AIOMetadata expects HOST_NAME.
if [ -z "${HOST_NAME:-}" ] && [ -n "${SPACE_HOST:-}" ]; then
  export HOST_NAME="https://${SPACE_HOST}"
fi

# Hugging Face does not provide AIOMetadata's local .env file.
# Use the documented SQLite database when DATABASE_URI is not configured.
if [ -z "${DATABASE_URI:-}" ]; then
  mkdir -p /app/addon/data
  export DATABASE_URI="sqlite://addon/data/db.sqlite"
fi

# HF Docker Spaces runs a single container. Start the local Redis service
# expected by AIOMetadata before starting the backend.
redis-server --daemonize yes

exec node dist/server/server.js
