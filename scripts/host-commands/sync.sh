#!/bin/bash
# Sync host command for NanoClaw
# Triggers the Prefect sync heartbeat flow for the personal vault.

set -euo pipefail

# Since NanoClaw runs in a sibling container setup with access to docker.sock,
# we can trigger Prefect via the homelab-prefect-worker-1 container.
# This avoids needing the Prefect CLI or API keys inside the NanoClaw orchestrator itself.

echo "Triggering personal-sync-heartbeat via Prefect..."
docker exec homelab-prefect-worker-1 prefect deployment run 'scheduled-job/personal-sync-heartbeat'
echo "Sync flow triggered successfully."
