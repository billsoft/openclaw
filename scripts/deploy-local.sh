#!/bin/bash
# Deploy OpenClaw to local production environment
# Usage: ./scripts/deploy-local.sh [port]

set -e

PORT=${1:-18789}
OPENCLAW_DIR="/Volumes/D 1/code/openclaw"
GATEWAY_PID_FILE="/tmp/openclaw-gateway.pid"

# Find node and pnpm (try common locations)
if command -v node &> /dev/null; then
    NODE_CMD="node"
elif [ -f "/usr/local/bin/node" ]; then
    NODE_CMD="/usr/local/bin/node"
else
    NODE_CMD="/usr/bin/env node"
fi

if command -v pnpm &> /dev/null; then
    PNPM="pnpm"
elif [ -f "$OPENCLAW_DIR/node_modules/.bin/pnpm" ]; then
    PNPM="$OPENCLAW_DIR/node_modules/.bin/pnpm"
else
    PNPM="/usr/local/bin/pnpm"
fi

echo "=== OpenClaw Local Deploy ==="

# 1. Kill existing gateway process on port
echo "[1/4] Checking for existing gateway on port $PORT..."
EXISTING_PID=$(lsof -ti :$PORT 2>/dev/null || true)
if [ -n "$EXISTING_PID" ]; then
    echo "  Found process $EXISTING_PID, killing..."
    kill $EXISTING_PID 2>/dev/null || true
    sleep 2
fi

# Also kill by pid file if exists
if [ -f "$GATEWAY_PID_FILE" ]; then
    OLD_PID=$(cat "$GATEWAY_PID_FILE")
    if [ -n "$OLD_PID" ] && kill -0 $OLD_PID 2>/dev/null; then
        echo "  Killing stale gateway process $OLD_PID..."
        kill $OLD_PID 2>/dev/null || true
    fi
    rm -f "$GATEWAY_PID_FILE"
fi

# 2. Pull latest from git
echo "[2/4] Pulling latest from origin/main..."
cd "$OPENCLAW_DIR"
git pull origin main

# 3. Build
echo "[3/4] Building..."
$PNPM build

# 4. Start gateway
echo "[4/4] Starting gateway on port $PORT..."
cd "$OPENCLAW_DIR"
$NODE_CMD dist/index.js gateway run --bind loopback --port $PORT &
GATEWAY_PID=$!
echo $GATEWAY_PID > "$GATEWAY_PID_FILE"
sleep 5

# Verify
if lsof -i :$PORT | grep -q LISTEN; then
    echo "=== Deploy Complete ==="
    echo "Gateway running on http://localhost:$PORT/"
    echo "PID: $GATEWAY_PID"
else
    echo "=== Deploy FAILED ==="
    echo "Gateway not listening on port $PORT"
    exit 1
fi
