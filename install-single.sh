#!/bin/bash
set -euo pipefail

# One-command install for a host that ALREADY runs Docker and may already have
# something listening on :80/:443 — Coolify's Traefik, Dokploy, CapRover, or a
# hand-rolled nginx. It installs the single-container panel (API + dashboard on
# one port) with the host Docker socket mounted, and never touches 80/443.
#
#   curl -fsSL https://raw.githubusercontent.com/godff619-arch/god-hostingg/main/install-single.sh | sudo bash
#
# On a host where 80/443 ARE free, prefer ./install.sh instead: that stack adds
# the nginx edge proxy, which is what serves custom domains and Let's Encrypt
# certificates. Without it, apps you deploy are reached at http://SERVER_IP:55xx.
#
# Re-run this script any time to upgrade: the repo is pulled, the image rebuilt,
# the container recreated. Named volumes are never removed, so accounts,
# projects and deployments survive.
#
# Knobs (all optional):
#   PANEL_PORT=3000            host port for the dashboard
#   PORT_RANGE_START=5500      host ports handed out to deployed apps
#   PORT_RANGE_END=5600
#   BRANCH=main                branch to install from
#   INSTALL_DIR=/opt/god-hosting
#   REQUIRE_BOOTSTRAP_SECRET=true   demand a printed code for the first account

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; YELLOW='\033[0;33m'
BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

REPO_URL="${REPO_URL:-https://github.com/godff619-arch/god-hostingg.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR="${INSTALL_DIR:-/opt/god-hosting}"
CONTAINER="${CONTAINER:-god-hosting}"
IMAGE="${IMAGE:-god-hosting:latest}"
PANEL_PORT="${PANEL_PORT:-3000}"
PORT_RANGE_START="${PORT_RANGE_START:-5500}"
PORT_RANGE_END="${PORT_RANGE_END:-5600}"

step() { printf "  ${CYAN}%s${NC} %s" "$1" "$2"; }
ok() { echo -e " ${GREEN}done${NC}"; }
die() { echo -e "\n  ${RED}Error:${NC} $1" >&2; exit 1; }

echo -e "\n  ${BOLD}God Hosting${NC} ${DIM}— single-container install (Docker socket mounted)${NC}\n"

[ "$(id -u)" -eq 0 ] || die "run with sudo"

step "[1/5]" "Checking Docker and git..."
command -v docker >/dev/null 2>&1 ||
  curl -fsSL https://get.docker.com | sh -s -- --quiet >/dev/null 2>&1 ||
  die "Docker is missing and could not be installed automatically"
docker version >/dev/null 2>&1 ||
  die "the Docker daemon is not responding — start it (systemctl start docker) and re-run"
if ! command -v git >/dev/null 2>&1; then
  { apt-get update -qq && apt-get install -y -qq git; } >/dev/null 2>&1 ||
    yum install -y git >/dev/null 2>&1 ||
    apk add --no-cache git >/dev/null 2>&1 ||
    die "git is missing and could not be installed automatically"
fi
ok

step "[2/5]" "Fetching code ($BRANCH)..."
if [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" remote set-url origin "$REPO_URL"
  git -C "$INSTALL_DIR" fetch -q origin "$BRANCH" || die "git fetch failed"
  git -C "$INSTALL_DIR" checkout -q -B "$BRANCH" "origin/$BRANCH" || die "git checkout failed"
else
  rm -rf "$INSTALL_DIR"
  git clone -q --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR" || die "git clone failed"
fi
ok

# Built on the host, for the host: the Dockerfile resolves TARGETARCH itself, so
# the same command produces an amd64 or arm64 image without extra flags.
step "[3/5]" "Building the image (first run takes a few minutes)..."
BUILD_LOG=$(mktemp)
if ! docker build -t "$IMAGE" "$INSTALL_DIR" >"$BUILD_LOG" 2>&1; then
  echo -e " ${RED}failed${NC}\n"
  tail -30 "$BUILD_LOG" >&2
  die "image build failed — full log: $BUILD_LOG"
fi
rm -f "$BUILD_LOG"
ok

# Recreated, not restarted: the image just changed. Volumes are addressed by name
# and are deliberately left alone, so this is also the upgrade path.
step "[4/5]" "Starting the container..."
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d \
  --name "$CONTAINER" \
  --restart unless-stopped \
  -p "${PANEL_PORT}:3000" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v god-hosting-data:/app/data \
  -v god-hosting-deployments:/deployments \
  -v god-hosting-nginx-conf:/nginx-conf \
  -v /etc/hostname:/host/hostname:ro \
  -v /etc/os-release:/host/os-release:ro \
  -v /proc:/host/proc:ro \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -e DATABASE_URL=file:/app/data/docklift.db \
  -e DATA_PATH=/app/data \
  -e DEPLOYMENTS_PATH=/deployments \
  -e NGINX_CONF_PATH=/nginx-conf \
  -e BACKUP_PATH=/app/data/backups \
  -e DOCKER_NETWORK=docklift_network \
  -e PORT_RANGE_START="$PORT_RANGE_START" \
  -e PORT_RANGE_END="$PORT_RANGE_END" \
  -e REQUIRE_BOOTSTRAP_SECRET="${REQUIRE_BOOTSTRAP_SECRET:-false}" \
  -e CORS_ORIGIN="${CORS_ORIGIN:-}" \
  "$IMAGE" >/dev/null || die "docker run failed"
ok

# /health/live needs no auth and no database, so it answers as soon as the API
# binds — a fresh install with nothing configured still reports healthy.
step "[5/5]" "Waiting for the panel to answer..."
READY=0
for _ in $(seq 1 60); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${PANEL_PORT}/health/live" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 2
done
if [ "$READY" -eq 1 ]; then
  ok
else
  echo -e " ${YELLOW}not yet${NC}"
  echo -e "  ${DIM}Container is up but /health/live has not answered in 120s. Logs:${NC}"
  echo -e "  ${DIM}  docker logs -f ${CONTAINER}${NC}"
fi

IP=$(curl -4 -fsS --max-time 3 https://api.ipify.org 2>/dev/null || echo "SERVER_IP")

echo -e "\n  ${GREEN}${BOLD}God Hosting is running${NC}\n"
echo -e "  ${BOLD}Dashboard:${NC}  http://${IP}:${PANEL_PORT}"
echo -e "  ${BOLD}App ports:${NC}  ${PORT_RANGE_START}-${PORT_RANGE_END} ${DIM}— open this range in the firewall${NC}"
echo -e "  ${DIM}Deployed apps are reached at http://${IP}:55xx. Custom domains served by"
echo -e "  God Hosting itself need a host where 80/443 are free (use ./install.sh there).${NC}"

case "$(printf '%s' "${REQUIRE_BOOTSTRAP_SECRET:-false}" | tr '[:upper:]' '[:lower:]')" in
  1 | true | yes | on)
    echo -e "\n  ${BOLD}First account:${NC} a setup code is required. Read it with:"
    echo -e "  ${DIM}  docker logs ${CONTAINER} | grep -A8 'bootstrap secret'${NC}"
    ;;
  *)
    echo -e "\n  ${YELLOW}First account is an open claim.${NC} Whoever opens the dashboard first"
    echo -e "  becomes OWNER, and registration then closes — ${BOLD}claim it now${NC}."
    echo -e "  ${DIM}Prefer a printed code? Re-run with REQUIRE_BOOTSTRAP_SECRET=true.${NC}"
    ;;
esac

echo -e "\n  ${DIM}The mounted Docker socket gives this container full control of the host"
echo -e "  engine — that is what lets it deploy your apps. Treat panel access as root"
echo -e "  access, and put HTTPS in front of it before using it over the internet.${NC}"
echo -e "\n  ${DIM}Upgrade:   curl -fsSL .../install-single.sh | sudo bash${NC}"
echo -e "  ${DIM}Logs:      docker logs -f ${CONTAINER}${NC}"
echo -e "  ${DIM}Stop:      docker stop ${CONTAINER}${NC}\n"
