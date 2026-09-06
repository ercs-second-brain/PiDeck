# agentskiss project

Inspect registered projects: repo URL, default branch, and automation settings.

## Syntax

```
agentskiss project <subcommand> [args] [flags]
```

## Subcommands

---

### agentskiss project get

Fetch one registered project.

**Syntax:**
```
agentskiss project get <id> [flags]
```

**Flags:**

| Flag | Meaning | Default / Required |
|---|---|---|
| `--json` | Output as JSON (a `Project` per `packages/shared/src/domain.ts`) | - |

**Example:**

```bash
agentskiss project get agentskiss --json
```

---

### agentskiss project ls

List registered projects.

**Syntax:**
```
agentskiss project ls [flags]
```

**Flags:**

| Flag | Meaning | Default / Required |
|---|---|---|
| `--json` | Output as JSON (array of `Project`) | - |

**Example:**

```bash
agentskiss project ls --json
```

## Daemon behavior

- `project get` → `GET /api/projects/:projectId`
- `project ls` → `GET /api/projects`

Creating, renaming, configuring, or deleting projects is a webapp/owner operation (`POST`/`PATCH`/`DELETE /api/projects...`), not an agent task — agents only read projects.
