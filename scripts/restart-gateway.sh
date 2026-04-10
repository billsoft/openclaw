#!/bin/zsh
# Restart OpenClaw Gateway (for updates)
# Usage: ./scripts/restart-gateway.sh [port]
#
# This script pulls latest code, rebuilds, and restarts the gateway service.
# Note: The service must be installed first via 'openclaw gateway install --port <port>'

set -e

PORT=${1:-18789}

echo "=== OpenClaw Gateway Restart ==="

# 1. Pull latest code
echo "[1/4] Pulling latest from origin/main..."
cd "/Volumes/D 1/code/openclaw"
git pull origin main

# 2. Build
echo "[2/4] Building..."
pnpm build && pnpm ui:build

# 3. Restart service using official restart command
echo "[3/4] Restarting gateway service..."
openclaw gateway restart --port $PORT

# 4. Wait for startup
echo "[4/4] Waiting for gateway to be ready..."
sleep 30

# Verify
STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/ 2>/dev/null || echo "000")
if [ "$STATUS" = "200" ]; then
    echo "=== Restart Complete ==="
    echo "Gateway running on http://localhost:$PORT/"
else
    echo "=== Warning: Gateway may not be ready yet (HTTP $STATUS) ==="
    echo "Check status with: openclaw gateway status"
fi
