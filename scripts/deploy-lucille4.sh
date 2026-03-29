#!/usr/bin/env bash
# Deploy nanoclaw updates to lucille4
# Handles: git pull, agent image rebuild, orchestrator restart, health check
#
# Usage:
#   ./scripts/deploy-lucille4.sh              # Pull + restart orchestrator
#   ./scripts/deploy-lucille4.sh --rebuild    # Also rebuild agent container image
#   ./scripts/deploy-lucille4.sh --full       # Full deploy: pull + rebuild + restart
set -euo pipefail

REMOTE_HOST="lucille4"
NANOCLAW_DIR="~/homelab-lucille4/nanoclaw"
COMPOSE_DIR="~/homelab-lucille4"
REPO_DIR="${NANOCLAW_DIR}/repo"
DB_PATH="${NANOCLAW_DIR}/store/messages.db"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
RESET='\033[0m'

# Require 1Password SSH agent
export SSH_AUTH_SOCK=~/Library/Group\ Containers/2BUA8C4S2C.com.1password/t/agent.sock

REBUILD=false
for arg in "$@"; do
    case "$arg" in
        --rebuild|--full) REBUILD=true ;;
    esac
done

run_remote() {
    ssh "$REMOTE_HOST" "$@"
}

step() {
    printf "${GREEN}==> %s${RESET}\n" "$1"
}

warn() {
    printf "${YELLOW}    %s${RESET}\n" "$1"
}

fail() {
    printf "${RED}ERROR: %s${RESET}\n" "$1"
    exit 1
}

# --- Pre-flight checks ---
step "Checking connectivity"
run_remote "hostname" >/dev/null 2>&1 || fail "Cannot SSH to ${REMOTE_HOST}"

# --- Pull latest code ---
step "Pulling nanoclaw source"
pull_output=$(run_remote "cd ${REPO_DIR} && git pull --ff-only 2>&1") || {
    echo "$pull_output"
    fail "git pull failed — repo may have diverged. Fix manually."
}
echo "$pull_output" | tail -3

# --- Clear stale sessions (preventive) ---
step "Checking for stale sessions"
session_count=$(run_remote "sudo sqlite3 ${DB_PATH} 'SELECT COUNT(*) FROM sessions;'" 2>/dev/null || echo "0")
if [ "$session_count" -gt "0" ]; then
    warn "Found ${session_count} stored session(s) — clearing to prevent stale session issues"
    run_remote "docker stop nanoclaw >/dev/null 2>&1 || true; sudo sqlite3 ${DB_PATH} 'DELETE FROM sessions;'"
fi

# --- Sync group config files (host groups dir shadows repo copy) ---
step "Syncing group config files"
for f in CLAUDE.md ADMIN.md; do
    if run_remote "cp ${REPO_DIR}/groups/main/${f} ${NANOCLAW_DIR}/groups/main/${f} 2>/dev/null"; then
        printf "${GREEN}    Synced groups/main/${f}${RESET}\n"
    fi
done

# --- Rebuild agent container image (optional) ---
if $REBUILD; then
    step "Rebuilding agent container image"
    run_remote "cd ${REPO_DIR}/container && ./build.sh" 2>&1 | tail -5
fi

# --- Restart orchestrator ---
step "Restarting nanoclaw"
run_remote "cd ${COMPOSE_DIR} && docker compose up -d nanoclaw" 2>&1 | grep -v '^time=' || true

# --- Health check ---
step "Waiting for startup"
sleep 10
health=$(run_remote "docker inspect --format='{{.State.Health.Status}}' nanoclaw 2>/dev/null" || echo "unknown")
status=$(run_remote "docker inspect --format='{{.State.Status}}' nanoclaw 2>/dev/null" || echo "unknown")

if [ "$status" = "running" ]; then
    printf "${GREEN}==> nanoclaw is running (health: ${health})${RESET}\n"
else
    fail "nanoclaw is ${status}"
fi

# --- Verify credential proxy reachable ---
step "Checking credential proxy"
proxy_mode=$(run_remote "docker logs nanoclaw --tail 20 2>&1 | grep -o 'authMode.*' | head -1" || echo "unknown")
if echo "$proxy_mode" | grep -q "api-key"; then
    printf "${GREEN}    Credential proxy: api-key mode${RESET}\n"
else
    warn "Credential proxy mode: ${proxy_mode}"
fi

# --- Verify Telegram connected ---
telegram=$(run_remote "docker logs nanoclaw --tail 20 2>&1 | grep -o 'Telegram bot connected'" || echo "")
if [ -n "$telegram" ]; then
    printf "${GREEN}    Telegram: connected${RESET}\n"
else
    warn "Telegram connection not confirmed in recent logs"
fi

# --- Check for errors ---
errors=$(run_remote "docker logs nanoclaw --tail 30 2>&1 | grep -c 'ERROR' || true")
if [ "${errors:-0}" -gt "0" ] 2>/dev/null; then
    warn "${errors} error(s) in recent logs — check with: ssh lucille4 docker logs nanoclaw --tail 50"
fi

echo ""
printf "${GREEN}Deploy complete.${RESET}\n"
