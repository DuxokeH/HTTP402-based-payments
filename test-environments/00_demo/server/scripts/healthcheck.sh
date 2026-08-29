#!/bin/sh
set -eu
PORT="${MERCHANT_PORT:-3000}"
curl -fsS "http://localhost:${PORT}/health" >/dev/null
