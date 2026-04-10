#!/bin/zsh
# Restart OpenClaw Gateway (for updates)
# Assumes service is already installed via: openclaw gateway install --port 18789
# Usage: ./scripts/restart-gateway.sh [port]

set -e

PORT=${1:-18789}

echo "=== OpenClaw Gateway Restart ==="

# 1. Stop service
echo "[1/3] Stopping gateway service..."
openclaw gateway stop 2>/dev/null || true

# 2. Pull latest code
echo "[2/3] Pulling latest from origin/main..."
cd "/Volumes/D 1/code/openclaw"
git pull origin main

# 3. Build
echo "[3/3] Building..."
pnpm build && pnpm ui:build

# 4. Start service
echo "Starting gateway service..."
openclaw gateway start

# Wait for startup
sleep 5

# Verify
if curl -s -o /dev/null -w "%{http_code}" http://localhost:$PORT/ | grep -q "200"; then
    echo "=== Restart Complete ==="
    echo "Gateway running on http://localhost:$PORT/"
else
    echo "=== Warning: Gateway may not be ready yet ==="
    echo "Check status with: openclaw gateway status"
fi
