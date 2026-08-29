#!/bin/bash

# X402 Demo Server - Stop Script
# Ustavi IZKLJUČNO proces, ki posluša na vratih tega strežnika (privzeto 3000),
# ne pa drugih procesov "node server.js" na istem računalniku.

PORT="${MERCHANT_PORT:-3000}"

port_pid() { ss -ltnp 2>/dev/null | grep ":$PORT " | grep -oP "pid=\K[0-9]+" | head -1; }

echo ""
echo "═══════════════════════════════════════════════════════════"
echo "  Zaustavljam X402 Demo Server (port $PORT)..."
echo "═══════════════════════════════════════════════════════════"
echo ""

PID=$(port_pid)
if [ -z "$PID" ]; then
    echo "❌ Na portu $PORT ne posluša noben proces"
    exit 1
fi

echo "Najden proces: PID $PID (port $PORT)"
kill "$PID"
sleep 2

if [ -n "$(port_pid)" ]; then
    echo "⚠️  Proces se ni zaustavil, uporabim force kill..."
    kill -9 "$(port_pid)"
    sleep 1
fi

if [ -n "$(port_pid)" ]; then
    echo "❌ NAPAKA: Server se ni zaustavil!"
    exit 1
else
    echo "✓ Server uspešno zaustavljen"
    echo ""
fi
