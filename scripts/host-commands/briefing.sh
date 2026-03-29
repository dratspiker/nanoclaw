#!/bin/bash
# Briefing host command for NanoClaw
# Generates a daily summary of meetings and tasks.

set -euo pipefail

# SSH directly to lucille5 to run briefing.
# Source heartbeat .env for API tokens (non-interactive SSH has no login shell).
ssh -o BatchMode=yes lucille5 'export PATH=/opt/homebrew/bin:$PATH && set -a && source ~/.config/heartbeat/.env && set +a && cd ~/git/obsidian-tools && .venv/bin/python src/personal/briefing.py 2>/dev/null'
