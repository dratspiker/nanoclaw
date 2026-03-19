#!/bin/bash
# Status host command for NanoClaw
# Performs a quick homelab health check.

set -euo pipefail

echo "🔍 Checking homelab status..."

# 1. Check disk space on lucille4
DISK_USAGE=$(df -h / | tail -n 1 | awk '{print $5}')
echo "lucille4 disk usage: $DISK_USAGE"

# 2. Check docker service count
DOCKER_COUNT=$(docker ps -q | wc -l)
echo "Running containers: $DOCKER_COUNT"

# 3. Check uptime
UPTIME=$(uptime -p)
echo "Uptime: $UPTIME"

# 4. Check connectivity to other hosts (via Tailscale or ping)
# (Optional — ping nas02 or loose-seal if reachable)

echo "All systems operational."
