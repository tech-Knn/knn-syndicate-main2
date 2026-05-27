#!/usr/bin/env bash
# One-time provisioning for a fresh Ubuntu Hetzner box. Run as root.
#   ssh root@<box> 'bash -s' < deploy/provision.sh
set -euo pipefail

echo "==> Updating packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update && apt-get upgrade -y

echo "==> Installing Docker Engine + Compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi

echo "==> Installing git + ufw"
apt-get install -y git ufw

echo "==> Configuring firewall (SSH + HTTP + HTTPS only)"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

systemctl enable --now docker

echo "==> Done. Next:"
echo "    1. git clone the repo (e.g. into /opt/knn)"
echo "    2. cp deploy/.env.staging.example deploy/.env.staging  &&  edit it"
echo "    3. point DNS (app/articles/go) at this box, then run deploy/deploy.sh"
