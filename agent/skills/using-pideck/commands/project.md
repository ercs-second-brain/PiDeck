# pideck project

Inspect registered projects: repo URL, default branch, and automation settings.

## Syntax

```
pideck project <subcommand> [args] [flags]
```

## Subcommands

---

### pideck project get

Fetch one registered project.

**Syntax:**
```
pideck project get <id> [--json]
```

**Flags:**

| Flag | Meaning | Default / Required |
|---|---|---|
| `--json` | Output as JSON (a `Project` per `packages/shared/src/domain.ts`) | - |

**Example:**

```bash
pideck project get pideck --json
```

---

### pideck project ls

List registered projects.

**Syntax:**
```
pideck project ls [--json]
```

**Flags:**

| Flag | Meaning | Default / Required |
|---|---|---|
| `--json` | Output as JSON (array of `Project`) | - |

**Example:**

```bash
pideck project ls --json
```

## Daemon behavior

- `project get` → `GET /api/projects/:projectId`
- `project ls` → `GET /api/projects`

Creating, renaming, configuring, or deleting projects is a webapp/owner operation (`POST`/`PATCH`/`DELETE /api/projects...`), not an agent task — agents only read projects.
