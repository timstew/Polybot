#!/usr/bin/env bash
set -e

echo "[polybot] Deploying Worker..."
cd worker && npx wrangler deploy
cd ..

echo "[polybot] Building Pages..."
cd web && bun run build:pages
cd ..

echo "[polybot] Deploying Pages..."
cd web && npx wrangler pages deploy out --project-name=polybot --commit-dirty=true --branch=main

echo "[polybot] Done!"
