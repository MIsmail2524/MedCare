#!/usr/bin/env bash
# MedCare Twin — one-command installer.
#
#   ./install.sh                 install, build, test and start (http://localhost:8080)
#   ./install.sh --dev           start with hot reload (API :8080, web :5173)
#   ./install.sh --docker        build and run with Docker Compose instead of Node
#   ./install.sh --no-start      install and build only
#   ./install.sh --skip-tests    skip the test suite
#   ./install.sh --port 3000     serve on another port
#   ./install.sh --dir ~/medcare clone/install into this directory when run outside the repo
#
# Supported: Linux and macOS (Windows: use WSL). Node.js is installed via nvm if missing (no sudo).
set -Eeuo pipefail

REPO_URL="https://github.com/MIsmail2524/MedCare.git"
NODE_MAJOR=22
NODE_MIN="22.13.0"
NVM_VERSION="v0.40.3"

MODE="prod"
START=1
TESTS=1
PORT=8080
DIR=""

c_blue=$'\033[1;34m'; c_green=$'\033[1;32m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_off=$'\033[0m'
step() { printf '\n%s==>%s %s\n' "$c_blue" "$c_off" "$*"; }
ok()   { printf '%s✔%s %s\n' "$c_green" "$c_off" "$*"; }
warn() { printf '%s!%s %s\n' "$c_yellow" "$c_off" "$*"; }
die()  { printf '%s✘ %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }
trap 'die "Failed at line $LINENO: $BASH_COMMAND"' ERR

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev) MODE="dev" ;;
    --docker) MODE="docker" ;;
    --no-start) START=0 ;;
    --skip-tests) TESTS=0 ;;
    --port) PORT="${2:?--port needs a value}"; shift ;;
    --dir) DIR="${2:?--dir needs a value}"; shift ;;
    -h|--help) usage ;;
    *) die "Unknown option: $1 (see --help)" ;;
  esac
  shift
done
[[ "$PORT" =~ ^[0-9]{2,5}$ ]] || die "Invalid port: $PORT"

have() { command -v "$1" >/dev/null 2>&1; }

version_ge() { # version_ge 22.14.0 22.13.0
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" == "$2" ]]
}

install_pkg() { # best-effort system package install for git/curl
  local pkg="$1"
  if have apt-get; then sudo apt-get update -y && sudo apt-get install -y "$pkg"
  elif have dnf; then sudo dnf install -y "$pkg"
  elif have yum; then sudo yum install -y "$pkg"
  elif have pacman; then sudo pacman -Sy --noconfirm "$pkg"
  elif have zypper; then sudo zypper install -y "$pkg"
  elif have brew; then brew install "$pkg"
  else die "Please install '$pkg' manually and re-run."
  fi
}

# ---------------------------------------------------------------------------
step "Checking platform"
OS="$(uname -s)"
case "$OS" in
  Linux|Darwin) ok "$OS $(uname -m)" ;;
  *) die "Unsupported OS '$OS'. On Windows run this inside WSL." ;;
esac

step "Checking prerequisites"
for tool in git curl; do
  if have "$tool"; then ok "$( "$tool" --version | head -n1 | cut -c1-40)"
  else warn "$tool not found — installing"; install_pkg "$tool"; fi
done
have openssl || warn "openssl not found — a Node-generated secret will be used"

# ---------------------------------------------------------------------------
step "Locating source"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
if [[ -f "$SCRIPT_DIR/package.json" && -d "$SCRIPT_DIR/packages/engine" ]]; then
  ROOT="$SCRIPT_DIR"
  ok "Using existing checkout at $ROOT"
else
  ROOT="${DIR:-$PWD/MedCare}"
  if [[ -d "$ROOT/.git" ]]; then
    ok "Updating $ROOT"
    git -C "$ROOT" pull --ff-only
  else
    ok "Cloning $REPO_URL into $ROOT"
    git clone "$REPO_URL" "$ROOT" || die "Clone failed. The repository is private: run 'gh auth login' or configure git credentials first."
  fi
fi
cd "$ROOT"

# ---------------------------------------------------------------------------
if [[ "$MODE" == "docker" ]]; then
  step "Checking Docker"
  have docker || die "Docker is not installed. Install Docker Desktop / Docker Engine, or run without --docker."
  docker info >/dev/null 2>&1 || die "Docker daemon is not running (or your user lacks permission)."
  if docker compose version >/dev/null 2>&1; then COMPOSE=(docker compose)
  elif have docker-compose; then COMPOSE=(docker-compose)
  else die "Docker Compose plugin not found."; fi
  ok "$(docker --version)"
else
  step "Checking Node.js (>= $NODE_MIN)"
  load_nvm() { export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; [[ -s "$NVM_DIR/nvm.sh" ]] && . "$NVM_DIR/nvm.sh"; }
  current=""
  have node && current="$(node -v | sed 's/^v//')"
  if [[ -n "$current" ]] && version_ge "$current" "$NODE_MIN"; then
    ok "Node.js v$current"
  else
    [[ -n "$current" ]] && warn "Node.js v$current is too old" || warn "Node.js not found"
    load_nvm || true
    if ! have nvm; then
      ok "Installing nvm $NVM_VERSION (user-local, no sudo)"
      curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" | PROFILE=/dev/null bash
      load_nvm
    fi
    have nvm || die "nvm installation failed; install Node.js $NODE_MAJOR manually from https://nodejs.org"
    nvm install "$NODE_MAJOR"
    nvm use "$NODE_MAJOR" >/dev/null
    ok "Node.js $(node -v) via nvm (add 'source ~/.nvm/nvm.sh' to your shell profile to keep it)"
  fi
  ok "npm $(npm -v)"
fi

# ---------------------------------------------------------------------------
step "Configuring environment (.env)"
gen_secret() {
  if have openssl; then openssl rand -hex 32
  else node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; fi
}
if [[ ! -f .env ]]; then
  cp .env.example .env
  secret="$(gen_secret)"
  # Local installs serve plain HTTP; set COOKIE_SECURE=true when behind HTTPS.
  sed -i.bak \
    -e "s|^APP_SECRET=.*|APP_SECRET=$secret|" \
    -e "s|^COOKIE_SECURE=.*|COOKIE_SECURE=false|" \
    -e "s|^TRUST_PROXY=.*|TRUST_PROXY=0|" \
    -e "s|^PORT=.*|PORT=$PORT|" \
    .env && rm -f .env.bak
  if [[ "$MODE" != "docker" ]]; then
    sed -i.bak -e "s|^DATABASE_PATH=.*|DATABASE_PATH=$ROOT/data/medcare.db|" .env && rm -f .env.bak
  fi
  chmod 600 .env
  ok "Created .env with a fresh APP_SECRET (file mode 600)"
else
  sed -i.bak -e "s|^PORT=.*|PORT=$PORT|" .env && rm -f .env.bak
  ok "Keeping existing .env"
fi
mkdir -p data

# ---------------------------------------------------------------------------
if [[ "$MODE" == "docker" ]]; then
  step "Building container image"
  "${COMPOSE[@]}" build
  if [[ $START -eq 1 ]]; then
    step "Starting container"
    "${COMPOSE[@]}" up -d
    for _ in $(seq 1 40); do curl -fsS "http://localhost:8080/api/health" >/dev/null 2>&1 && break; sleep 1; done
    curl -fsS "http://localhost:8080/api/health" >/dev/null || die "Container did not become healthy. Check: ${COMPOSE[*]} logs"
    ok "Running at http://localhost:8080  (logs: ${COMPOSE[*]} logs -f · stop: ${COMPOSE[*]} down)"
  fi
  exit 0
fi

step "Installing dependencies"
npm ci --ignore-scripts --no-audit --no-fund
ok "Dependencies installed"

step "Building engine, web app and server"
npm run build
ok "Build complete"

if [[ $TESTS -eq 1 ]]; then
  step "Running test suite"
  npm test
  ok "All tests passed"
fi

if [[ $START -eq 0 ]]; then
  ok "Installed. Start later with: ./install.sh --skip-tests  (or: set -a; . ./.env; set +a; npm start)"
  exit 0
fi

set -a; . ./.env; set +a
if [[ "$MODE" == "dev" ]]; then
  step "Starting development servers (Ctrl+C to stop)"
  printf '   API  http://localhost:%s\n   Web  http://localhost:5173\n' "$PORT"
  printf '   Demo login: demo@medcare.dev / %s\n' "${DEMO_PASSWORD:-MedCare-Demo-2026}"
  exec npm run dev
else
  export NODE_ENV=production
  step "Starting MedCare Twin (Ctrl+C to stop)"
  printf '   Open http://localhost:%s\n' "$PORT"
  printf '   Demo login: demo@medcare.dev / %s\n' "${DEMO_PASSWORD:-MedCare-Demo-2026}"
  exec npm start
fi
