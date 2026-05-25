# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation
#
# Requires base image: docker build -t nanoclaw-agent-base:latest -f Dockerfile.base .
# Then:                 docker build -t nanoclaw-agent:latest .

FROM nanoclaw-agent-base:latest

LABEL nanoclaw.protected=true

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript and cache source hash for fast startup
RUN npm run build && \
    find src -name '*.ts' -exec sha256sum {} \; | sort | sha256sum | cut -d' ' -f1 > /app/dist/.src-hash

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Initialize git repo in workspace so Claude Agent SDK doesn't log "fatal: not in a git directory"
RUN cd /workspace/group && git init && git config user.email "agent@nanoclaw" && git config user.name "agent" && git commit --allow-empty -m "init"

# Create entrypoint script
# Skips tsc recompilation if source files haven't changed since docker build.
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
COPY <<'ENTRYPOINT' /app/entrypoint.sh
#!/bin/bash
set -e
cd /app

# Check if mounted source differs from build-time source
CURRENT_HASH=$(find src -name '*.ts' -exec sha256sum {} \; 2>/dev/null | sort | sha256sum | cut -d' ' -f1)
BUILT_HASH=$(cat /app/dist/.src-hash 2>/dev/null || echo "none")

if [ "$CURRENT_HASH" = "$BUILT_HASH" ]; then
  # Source unchanged — use pre-built dist directly
  cp -r /app/dist /tmp/dist
else
  # Source was customized — recompile
  npx tsc --outDir /tmp/dist 2>&1 >&2
fi

ln -sf /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
ENTRYPOINT
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
