#!/bin/bash
set -e

cd /root/qir

echo "=== KPFK QIR Deploy ==="
echo "$(date)"

git pull origin main

echo "→ Pulling latest image..."
docker compose pull

echo "→ Restarting containers..."
docker compose up -d

echo "→ Cleaning up old images..."
docker image prune -f

echo ""
docker compose ps

echo "=== Deploy complete ==="
