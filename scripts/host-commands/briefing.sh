#!/bin/bash
# Briefing host command for NanoClaw
# Generates a daily summary of meetings and tasks.

set -euo pipefail

# Run briefing via Prefect worker (has SSH access to lucille5).
# Source heartbeat .env on lucille5 for API tokens (non-interactive SSH has no login shell).
docker exec -t homelab-prefect-worker-1 ssh -o BatchMode=yes lucille5 'export PATH=/opt/homebrew/bin:$PATH && set -a && source ~/.config/heartbeat/.env && set +a && cd ~/git/obsidian-tools && .venv/bin/python src/personal/briefing.py'
