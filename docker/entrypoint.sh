#!/bin/sh
set -e

# Hugging Face Spaces provides SPACE_HOST. AIOMetadata expects HOST_NAME.
if [ -z "${HOST_NAME:-}" ] && [ -n "${SPACE_HOST:-}" ]; then
  export HOST_NAME="https://${SPACE_HOST}"
fi

exec node dist/server/server.js
