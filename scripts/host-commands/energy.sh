#!/bin/bash
# Energy host command for NanoClaw
# Recommends tasks based on energy level.

set -euo pipefail

LEVEL="${1:-low}"

# Run the energy tasks script on lucille5 via the homelab-prefect-worker-1 (which has SSH)
docker exec -t homelab-homelab-prefect-worker-1-1 ssh -o BatchMode=yes lucille5 "cd ~/git/obsidian-tools && uv run --with requests --with structlog python3 src/personal/energy_tasks.py \"$LEVEL\""
