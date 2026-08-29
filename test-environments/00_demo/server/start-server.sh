#!/bin/bash
# X402 Hosting Server — start helper for systemd-less hosts.

set -eu

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Starting X402 Hosting Server..."
echo "═══════════════════════════════════════════════════════════"
echo ""

if [ ! -f wallet.json ]; then
    echo "ERROR: wallet.json does not exist."
    echo "   Run from the repository root:  node generate-wallet.js"
    exit 1
fi

if [ ! -f .env ]; then
    echo "WARNING: .env not found. Copy .env.example to .env and edit it before going to production."
fi

# Load .env if present (does not override anything already in the environment)
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
fi

export NODE_ENV="${NODE_ENV:-production}"
export MERCHANT_PORT="${MERCHANT_PORT:-3000}"

exec node server.js
