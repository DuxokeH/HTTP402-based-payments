#!/bin/bash

# X402 Demo Server - Stop Script
# Stops ONLY the process listening on this server's port (default 3000),
# not other "node server.js" processes on the same machine.

PORT="${MERCHANT_PORT:-3000}"

port_pid() { ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP "pid=\K[0-9]+" | head -1; }

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Stopping X402 Demo Server (port $PORT)..."
echo "═══════════════════════════════════════════════════════════"
echo ""

PID=$(port_pid)
if [ -z "$PID" ]; then
    echo "❌ No process is listening on port $PORT"
    exit 1
fi

echo "Found process: PID $PID (port $PORT)"
kill "$PID"
sleep 2

if [ -n "$(port_pid)" ]; then
    echo "⚠️  Process did not stop, using force kill..."
    kill -9 "$(port_pid)"
    sleep 1
fi

if [ -n "$(port_pid)" ]; then
    echo "❌ ERROR: Server did not stop!"
    exit 1
else
    echo "✓ Server stopped successfully"
    echo ""
fi
