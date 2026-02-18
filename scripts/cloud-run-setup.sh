#!/usr/bin/env bash
set -e

PROJECT_ID="polybot-api"
REGION="us-central1"
SERVICE_NAME="polybot-api"

echo "=== Polybot Cloud Run Setup ==="
echo ""
echo "Step 1: Install gcloud CLI (if not installed)"
echo ""

if ! command -v gcloud &> /dev/null; then
  echo "gcloud not found. Installing..."
  brew install google-cloud-sdk
fi

echo "Step 2: Authenticate"
echo ""
gcloud auth login

echo ""
echo "Step 3: Create project (if needed)"
echo ""
gcloud projects create "$PROJECT_ID" --name="Polybot API" 2>/dev/null || echo "Project already exists"
gcloud config set project "$PROJECT_ID"

echo ""
echo "Step 4: Enable required APIs"
echo ""
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

echo ""
echo "Step 5: Deploy to Cloud Run (builds and deploys in one step)"
echo ""
gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 1 \
  --set-env-vars "POLYBOT_DB_PATH=data/polybot.db,CLOUDFLARE_WORKER_URL=https://polybot-copy-listener.timstew.workers.dev"

echo ""
echo "=== Done! ==="
echo ""
echo "Your Cloud Run URL:"
gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format="value(status.url)"
echo ""
echo "Next steps:"
echo "1. Copy the URL above"
echo "2. Update worker/src/index.ts PYTHON_API_URL with it"
echo "3. Run: bun run deploy"
