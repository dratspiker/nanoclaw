#!/bin/bash
# Capture host command for NanoClaw
# Captures a thought or task and routes it to the appropriate system.

set -euo pipefail

ITEM="$1"

if [ -z "$ITEM" ]; then
    echo "Error: No item provided."
    exit 1
fi

# Run the smart capture script on lucille5 via the homelab-prefect-worker-1 (which has SSH)
docker exec -t homelab-prefect-worker-1 ssh -o BatchMode=yes lucille5 "cd ~/git/obsidian-tools && .venv/bin/python src/personal/capture.py \"$ITEM\""
