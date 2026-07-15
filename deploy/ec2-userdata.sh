#!/bin/bash
# ------------------------------------------------------------------------------
# EC2 user-data bootstrap for the Multiplayer Agent Workspace (Amazon Linux 2023).
#
# Paste this into the "User data" box when launching the instance (edit the two
# CONFIG values first). On first boot it installs Docker + git, builds the app
# image, and runs it on port 80 with auto-restart. The agent authenticates to
# Amazon Bedrock via the instance's IAM role — no static keys.
#
# Requirements on the instance:
#   - IAM instance profile with bedrock:InvokeModel[WithResponseStream]
#   - Security group inbound: 80 (and 22 for SSH)
#   - Amazon Nova Pro enabled in Bedrock "Model access" for AWS_REGION
# ------------------------------------------------------------------------------
set -euxo pipefail

# ---- CONFIG (edit these two) -------------------------------------------------
REPO_URL="https://github.com/YOUR_USER/YOUR_REPO.git"
AWS_REGION="us-east-1"
# ------------------------------------------------------------------------------

dnf update -y
dnf install -y docker git
systemctl enable --now docker

APP_DIR=/opt/maw
rm -rf "$APP_DIR"
git clone "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"

mkdir -p /opt/maw-data

docker build -t maw:latest .

# Remove any previous container, then run mapping host :80 -> container :8787.
docker rm -f maw 2>/dev/null || true
docker run -d \
  --name maw \
  --restart always \
  -p 80:8787 \
  -e AWS_REGION="$AWS_REGION" \
  -e BEDROCK_REGION="$AWS_REGION" \
  -v /opt/maw-data:/data \
  maw:latest

echo "Multiplayer Agent Workspace is starting on http://<this-instance-public-dns>/"
