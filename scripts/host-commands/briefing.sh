#!/bin/bash
# Briefing host command for NanoClaw
# Generates a daily summary of meetings and tasks.

set -euo pipefail

# Since NanoClaw runs in a sibling container setup with access to docker.sock,
# we can use another container that has SSH access to lucille5, 
# or run it via Prefect if a briefing flow is defined.

# For now, let's try running it via the homelab-prefect-worker-1 which already has ~/.ssh mounted.
# We'll run the python script directly on lucille5 via SSH.

docker exec -t homelab-prefect-worker-1 ssh -o BatchMode=yes lucille5 "cd ~/git/obsidian-tools && .venv/bin/python src/personal/briefing.py"
