#!/bin/bash
# Build the NanoClaw agent container image

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE_NAME="nanoclaw-agent"
BASE_IMAGE_NAME="nanoclaw-agent-base"
TAG="${1:-latest}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-docker}"

# Always build the base first — cheap when fully cached, correct when missing.
# Without this, a `docker image prune` that nukes the base leaves a deploy
# unable to rebuild the agent (FROM nanoclaw-agent-base:latest fails to pull).
echo "Building NanoClaw agent base image..."
echo "Image: ${BASE_IMAGE_NAME}:${TAG}"
${CONTAINER_RUNTIME} build -t "${BASE_IMAGE_NAME}:${TAG}" -f Dockerfile.base .

echo ""
echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE_NAME}:${TAG}"

${CONTAINER_RUNTIME} build -t "${IMAGE_NAME}:${TAG}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE_NAME}:${TAG}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE_NAME}:${TAG}"
