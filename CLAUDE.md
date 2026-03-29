# NanoClaw

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Quick Context

Single Node.js process with skill-based channel system. Channels (WhatsApp, Telegram, Slack, Discord, Gmail) are skills that self-register at startup. Messages route to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/channels/registry.ts` | Channel registry (self-registration at startup) |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/router.ts` | Message formatting and outbound routing |
| `src/config.ts` | Trigger pattern, paths, intervals |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/task-scheduler.ts` | Runs scheduled tasks |
| `src/db.ts` | SQLite operations |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream NanoClaw updates into a customized install |
| `/qodo-pr-resolver` | Fetch and fix Qodo PR review issues interactively or in batch |
| `/get-qodo-rules` | Load org- and repo-level coding rules from Qodo before code tasks |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # restart

# Linux (systemd)
systemctl --user start nanoclaw
systemctl --user stop nanoclaw
systemctl --user restart nanoclaw
```

## Deployment (lucille4 — Docker-in-Docker)

The orchestrator runs containerized on lucille4, spawning agent containers via the host Docker socket. This DinD model requires specific configuration that upstream doesn't account for.

### Deploy script

```bash
./scripts/deploy-lucille4.sh              # Pull + restart
./scripts/deploy-lucille4.sh --rebuild    # Also rebuild agent container image
```

The script handles: git pull, stale session cleanup, container restart, and health verification.

### DinD gotchas (solved)

These are the known DinD-specific issues — all fixed, documented here to prevent regressions:

| Issue | Root cause | Fix |
|-------|-----------|-----|
| Agent containers have empty `/app/src/` | Bind mount paths use container-internal paths; host Docker can't resolve them | `HOST_PROJECT_ROOT` env var in compose (`7b01ada`) |
| Credential proxy ECONNREFUSED | Port bound to `127.0.0.1:3001` but agent containers hit `172.17.0.1` via `host.docker.internal` | Bind to `172.17.0.1:3001` in compose |
| `.env` symlink broken in container | `repo/.env` → `../../.env` resolves to `/.env` inside container | `process.env` fallback in `readEnvFile()` (`bc50e74`) |
| IPC file permission errors | Agent container runs as different UID than orchestrator | `chmod` IPC dirs (`72320f8`) |
| Missing source code | `repo/` dir is gitignored, must be cloned manually | Documented in `nanoclaw/README.md` |
| Stale session infinite retry | Failed session ID persisted and retried forever | Clear session on "conversation not found" (`d64cee6`) |

### Upstream update policy

**Do not merge upstream main blindly.** Cherry-pick specific fixes instead. This fork has DinD-specific patches that upstream may overwrite.

```bash
git remote add upstream https://github.com/qwibitai/nanoclaw.git
git fetch upstream
git log --oneline upstream/main ^main | head -20  # See what's new
git cherry-pick <commit>                           # Pick specific fixes
```

### Pinned version

Current deployment is pinned to fork commit `d64cee6` (2026-03-29). Update `repo/` on lucille4 only via the deploy script.

## Troubleshooting

**WhatsApp not connecting after upgrade:** WhatsApp is now a separate channel fork, not bundled in core. Run `/add-whatsapp` (or `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git && git fetch whatsapp main && (git merge whatsapp/main || { git checkout --theirs package-lock.json && git add package-lock.json && git merge --continue; }) && npm run build`) to install it. Existing auth credentials and groups are preserved.

**Stale session retry loop:** If Barry stops responding and logs show "No conversation found with session ID", the session invalidation fix should handle it automatically. If it persists, clear manually: `sudo sqlite3 ~/homelab-lucille4/nanoclaw/store/messages.db 'DELETE FROM sessions;'` then restart.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
