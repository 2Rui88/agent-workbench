#!/bin/bash
set -euo pipefail

REPO_URL="https://git.leke.run/jandejang/cli-session-task-mcp.git"
APP_DIR="/opt/cli-session-task-mcp"
SERVICE_USER="deploy"
SERVICE_GROUP="deploy"
ENV_FILE="/etc/default/cli-session-task-mcp"

echo "=== CLI Session Task MCP - Linux Deployment ==="

command -v node &>/dev/null || { echo "Error: Node.js >= 24.19.0 required"; exit 1; }
NODE_VERSION=$(node --version | sed 's/^v//')
if ! node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); process.exit(major > 24 || (major === 24 && (minor > 19 || (minor === 19 && patch >= 0))) ? 0 : 1)'; then
  echo "Error: Node.js >= 24.19.0 required (found v$NODE_VERSION)"
  exit 1
fi
echo "Node.js: v$NODE_VERSION"
command -v npm &>/dev/null || { echo "Error: npm 11.x required"; exit 1; }
NPM_VERSION=$(npm --version)
if ! npm --version | awk -F. '($1 == 11) { found = 1 } END { exit(found ? 0 : 1) }'; then
  echo "Error: npm 11.x required (found $NPM_VERSION)"
  exit 1
fi
echo "npm: $NPM_VERSION"

# Dedicated service identity. The application tree only needs to be readable;
# runtime writes are restricted to APP_DIR/data by the systemd sandbox.
if ! getent group "$SERVICE_GROUP" &>/dev/null; then
  sudo groupadd --system "$SERVICE_GROUP"
fi
if ! id -u "$SERVICE_USER" &>/dev/null; then
  NOLOGIN_SHELL=$(command -v nologin || true)
  if [ -z "$NOLOGIN_SHELL" ]; then
    NOLOGIN_SHELL="/usr/sbin/nologin"
  fi
  sudo useradd \
    --system \
    --gid "$SERVICE_GROUP" \
    --home-dir "$APP_DIR" \
    --no-create-home \
    --shell "$NOLOGIN_SHELL" \
    "$SERVICE_USER"
fi

# Clone or pull
if [ -d "$APP_DIR/.git" ]; then
  echo "Updating existing deployment..."
  cd "$APP_DIR"
  git pull origin main
else
  echo "Cloning from $REPO_URL..."
  sudo mkdir -p "$APP_DIR"
  sudo chown "$(whoami)" "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

# Install and build
npm ci
npm run build

# Data directory and Host gate configuration
sudo install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$APP_DIR/data"
SERVER_IP=$(hostname -I | awk '{print $1}')
SERVER_NAME=$(hostname -f 2>/dev/null || hostname)
ALLOWED_HOSTS="127.0.0.1:47321,localhost:47321"
if [ -n "$SERVER_IP" ]; then
  ALLOWED_HOSTS="$ALLOWED_HOSTS,$SERVER_IP:47321"
fi
if [ -n "$SERVER_NAME" ]; then
  ALLOWED_HOSTS="$ALLOWED_HOSTS,$SERVER_NAME:47321"
fi
TEMP_ENV=$(mktemp)
trap 'rm -f "$TEMP_ENV"' EXIT
printf 'TASK_MCP_ALLOWED_HOSTS=%s\n' "$ALLOWED_HOSTS" > "$TEMP_ENV"
sudo install -o root -g root -m 0644 "$TEMP_ENV" "$ENV_FILE"
rm -f "$TEMP_ENV"
trap - EXIT

# Systemd service
sudo cp deploy/systemd/cli-session-task-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable cli-session-task-mcp
sudo systemctl restart cli-session-task-mcp

echo ""
echo "=== Deployed ==="
echo "Health: curl http://$SERVER_IP:47321/health"
echo "Board:  http://$SERVER_IP:47321/board"
echo "MCP:    http://$SERVER_IP:47321/mcp"
