# AGENTS.md — Claude-Mem

> Local companion to the tracked `CLAUDE.md`. Maintained by hand for AI
> agents working in this checkout — verify commands against
> `package.json` before trusting them.

## Project Overview

Claude-mem is a Claude Code plugin providing persistent memory across sessions. It captures tool usage, compresses observations using the Claude Agent SDK, and injects relevant context into future sessions. Exposes both an MCP plugin interface and a packaged SDK (`claude-mem/sdk`).

## Architecture

```
src/
├── index.ts              # Main package entry
├── sdk/                   # Public SDK surface (bundled via esbuild with the rest; see "Critical Rules")
├── server/                # HTTP server (Express, Better Auth)
├── services/              # Worker service, observation pipeline
├── servers/               # MCP server implementations
├── core/                  # Core memory compression logic
├── storage/               # SQLite/Postgres adapters
├── cli/                   # CLI subcommands
├── npx-cli/               # NPX binary entrypoint
├── hooks/                 # Plugin hook handlers
├── integrations/          # Third-party integrations
├── build/                 # Build-time tooling
├── shared/                # Shared utilities
├── types/                 # TypeScript type definitions
├── utils/                 # Utility functions
├── supervisor/            # Process supervision
└── ui/                    # Web viewer (React, separate tsconfig)
```

The worker service runs as a long-lived process (`plugin/scripts/worker-service.cjs`), communicating via BullMQ queues backed by Valkey/Redis. The SDK surface (`src/sdk`) stays lean through the dependency discipline in `//dependencies-note` (`package.json`): only live-import survivors are runtime deps, everything else is esbuild-inlined at build time.

## Commands

All from `package.json`:

### Build & Development

| Command | Purpose |
|---------|---------|
| `npm run dev` | Full build + sync marketplace + restart worker |
| `npm run build` | Build everything (manifests, hooks, lockfile) |
The SDK (`src/sdk`) ships through the standard build — there is no
separate SDK build step. Bundle discipline (no worker/server leakage
into SDK consumers) is enforced by the `//dependencies-note` in
`package.json`: only live-import survivors stay as runtime deps, the
rest is esbuild-inlined at build time.
| `npm run build-and-sync` | Build, sync marketplace, restart worker |

### Testing

| Command | Purpose |
|---------|---------|
| `npm test` | Run all tests (bun test) |
| `npm run test:sqlite` | SQLite storage tests |
| `npm run test:agents` | Worker agent tests |
| `npm run test:search` | Search tests |
| `npm run test:context` | Context tests |
| `npm run test:infra` | Infrastructure tests |
| `npm run test:server` | Server tests |
| `npm run e2e:server:docker` | Server E2E in Docker |

### Type Checking & Linting

| Command | Purpose |
|---------|---------|
| `npm run typecheck` | Full typecheck (root + viewer tsconfigs) |
| `npm run typecheck:root` | Root tsconfig only |
| `npm run typecheck:viewer` | Viewer tsconfig only |
| `npm run lint:hook-io` | Check hook I/O discipline |
| `npm run lint:spawn-env` | Check spawn env discipline |

### Worker Management

| Command | Purpose |
|---------|---------|
| `npm run worker:start` | Start worker service |
| `npm run worker:stop` | Stop worker service |
| `npm run worker:restart` | Restart worker service |
| `npm run worker:status` | Check worker status |
| `npm run worker:logs` | Tail worker logs (last 50 lines) |
| `npm run worker:tail` | Follow worker logs |

### Queue & Release

| Command | Purpose |
|---------|---------|
| `npm run queue` | Check pending queue |
| `npm run queue:process` | Process pending queue |
| `npm run release` | Publish release (np) |
| `npm run release:patch` | Publish patch release |

### Additional Scripts

`sync-marketplace`, `build:binaries`, `build:cli-binary`, `changelog:generate`, `discord:notify`, `queue:clear:pending`, `pr:status`, `claude-md:regenerate`, `strip-comments`, `translate-readme`, `bug-report`, `cursor:*`, `smoke:clean-room`, `prepublishOnly`, `check:postinstall-allowlist`, `release:minor`, `release:major`.

## Docker Compose

`docker-compose.yml` defines the server-beta stack: Postgres 17 (canonical storage) + Valkey 8 (BullMQ queue) + `claude-mem-server` (HTTP, no generation) + `claude-mem-worker` (BullMQ consumer, scale via `--scale claude-mem-worker=N`).

Required env vars: `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `CLAUDE_MEM_RUNTIME=server-beta`, `CLAUDE_MEM_QUEUE_ENGINE=bullmq`, `CLAUDE_MEM_SERVER_DATABASE_URL`, `CLAUDE_MEM_AUTH_MODE=api-key`.

## Key Files

| File | Role |
|------|------|
| `package.json` | Scripts (57 entries), dependencies, exports, bin entry |
| `tsconfig.json` | TypeScript config (ES2022, ESNext, React JSX) |
| `tsup.config.ts` | SDK bundler config |
| `docker-compose.yml` | Server-beta production stack |
| `docker/claude-mem/Dockerfile` | Container build |
| `plugin/` | Built plugin artifacts (hooks, scripts, skills, UI) |
| `scripts/` | Build and maintenance scripts |
| `docs/` | Internal documentation (architecture, API, migration guides) |
| `tests/` | Test suites (bun test runner) |

## File Locations (runtime)

- **Installed Plugin**: `~/.claude/plugins/marketplaces/thedotmack/`
- **Database**: `~/.claude-mem/claude-mem.db` (SQLite) or Postgres (server-beta)
- **Chroma**: `~/.claude-mem/chroma/`

## Critical Rules

- The SDK surface (`src/sdk`) MUST NOT drag in worker, HTTP routes, BullMQ, or `bun:sqlite`. This is enforced by the dependency discipline in `//dependencies-note` (`package.json`): inlined-at-build deps stay devDependencies and are never downloaded by SDK consumers.
- Dependencies that are esbuild-inlined into the worker/server/npx bundles are devDependencies — they are NOT downloaded by SDK consumers (see `//dependencies-note` in `package.json`).
- Changelog is auto-generated — do not edit `CHANGELOG.md` manually.
- Server-beta Docker stack requires all `POSTGRES_*` secrets; it will refuse to start if any are missing.
