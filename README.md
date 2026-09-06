# agentsKISS

A self-hosted, single-command AI coding agent orchestration platform — pi coding agent workers, driven by GitHub issues and PRs, managed from a kanban and browser terminals on your own machine.

See [docs/agentskiss-prd.md](docs/agentskiss-prd.md) for the PRD and [docs/agentskiss-concept.md](docs/agentskiss-concept.md) for the concept brief.

## Repository layout

TypeScript monorepo managed with [pnpm workspaces](https://pnpm.io/workspaces):

| Path              | Package                | Purpose                                                                 |
| ----------------- | ---------------------- | ----------------------------------------------------------------------- |
| `apps/daemon/`    | `@agentskiss/daemon`   | Orchestration backend: projects, issue/PR watchers, tmux session control |
| `apps/web/`       | `@agentskiss/web`      | Web app: kanban board, browser terminals, diff review                    |
| `packages/shared/`| `@agentskiss/shared`   | Shared types and utilities used by daemon and web                        |
| `agent/`          | `@agentskiss/agent`    | pi coding agent integration: skills, extensions, prompts                 |
| `install/`        | `@agentskiss/install`  | One-line install and service setup (launchd/systemd/WSL)                 |

## Development setup

Prerequisites:

- Node.js >= 22
- pnpm (enabled via corepack, pinned by `packageManager` in `package.json`)

```sh
# Enable pnpm from the pinned version (one-time)
corepack enable pnpm

# Install all workspace dependencies
pnpm install

# Build every workspace package
pnpm build

# Run tests (vitest)
pnpm test

# Lint and typecheck
pnpm lint
pnpm typecheck
```

The same steps run in CI (`.github/workflows/ci.yml`) on every pull request.
