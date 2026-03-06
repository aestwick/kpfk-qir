#!/usr/bin/env bash
set -euo pipefail

cd /root/qir

echo "==> Pulling latest from GitHub..."
git pull origin main

echo "==> Stopping containers..."
docker compose down

echo "==> Building and starting containers..."
docker compose up -d --build

echo "==> Pruning old images..."
docker image prune -f

echo "==> Status:"
docker compose ps
