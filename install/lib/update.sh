# shellcheck shell=sh
#
# Self-update check/apply for the pideck CLI (issue #55).
#
# Sourced by install/bin/pideck after common.sh (needs PD_HOME, PD_LIB
# and the logging/run helpers). Pairs with install/lib/source.sh, whose
# resolve_source/build_from_source the apply path reuses so private repos
# and dev refs update exactly like installer runs do.
#
# Check semantics (shared with the daemon's /api/update, apps/daemon/src/api/update.ts):
#   - local revision:  git -C $PD_SRC rev-parse HEAD
#   - upstream head:   gh api repos/:owner/:repo/commits/<ref>  (--jq .sha)
#   - repo/ref:        $PD_HOME/config.json (the installer's record) with a
#                      git-remote fallback, so private repos and non-main
#                      dev refs check like public ones.
#
# Repo rename (issue #125): the repo moved agentsKISS -> PiDeck. GitHub
# redirects renamed repos, so a config.json (or git remote) still recording
# the pre-rename https://github.com/ercs-second-brain/agentsKISS.git URL
# keeps working — clone/fetch/gh-api all follow the redirect. Installs made
# after the rename record the new https://github.com/ercs-second-brain/
# PiDeck.git URL (lib/common.sh default). No URL rewrite is needed here; the
# recorded URL is used as-is either way.

# The installed source checkout (PD_SRC is exported by $PD_HOME/env).
UPDATE_SRC="${PD_SRC:-$PD_HOME/src}"

# Read repoUrl/repoRef from $PD_HOME/config.json into PD_REPO_URL/PD_REPO_REF.
# No-op (returns 1) when the file or a field is missing — callers then fall
# back to the git remote / common.sh defaults.
load_repo_config() {
  _lrc_file="$PD_HOME/config.json"
  [ -f "$_lrc_file" ] || return 1
  _lrc_url=$(sed -n 's/.*"repoUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_lrc_file")
  _lrc_ref=$(sed -n 's/.*"repoRef"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_lrc_file")
  [ -n "$_lrc_url" ] || return 1
  PD_REPO_URL=$_lrc_url
  [ -n "$_lrc_ref" ] && PD_REPO_REF=$_lrc_ref
  return 0
}

# GitHub owner/name slug from a repo URL (https or ssh, .git optional).
# Prints nothing and returns 1 when the URL has no GitHub slug.
repo_slug() {
  printf '%s' "$1" | sed 's/\.git$//' | sed -n 's|^https://github\.com/||p; s|^git@github\.com:||p'
}

# update_check — compare the local source HEAD with the upstream ref via gh.
#
# Sets (and clears first):
#   UPDATE_LOCAL_SHA   full SHA of the local checkout ('' when unavailable)
#   UPDATE_REMOTE_SHA  full SHA of the upstream ref head ('' when unavailable)
#   UPDATE_LOCAL_MISSING  1 when the local checkout had no usable revision
#                      (missing or corrupt — issue #221); '' otherwise
#   UPDATE_REPO        owner/name (or the raw URL when it has no slug)
#   UPDATE_REF         tracked upstream ref
#   UPDATE_ERROR       human-readable failure detail ('' on success)
#
# Returns 0 when both revisions resolved, 1 otherwise (UPDATE_ERROR explains).
update_check() {
  UPDATE_LOCAL_SHA=
  UPDATE_REMOTE_SHA=
  UPDATE_LOCAL_MISSING=
  UPDATE_REPO=
  UPDATE_REF=
  UPDATE_ERROR=

  if load_repo_config; then
    UPDATE_REF=${PD_REPO_REF:-main}
  elif [ -d "$UPDATE_SRC/.git" ]; then
    # No installer config (dev checkout): track what the clone tracks.
    PD_REPO_URL=$(git -C "$UPDATE_SRC" remote get-url origin 2>/dev/null) || PD_REPO_URL=
    UPDATE_REF=${PD_REPO_REF:-main}
  else
    UPDATE_REF=${PD_REPO_REF:-main}
  fi

  _uc_slug=$(repo_slug "${PD_REPO_URL:-}")
  if [ -n "$_uc_slug" ]; then
    UPDATE_REPO=$_uc_slug
  else
    UPDATE_REPO=${PD_REPO_URL:-unknown}
  fi

  if [ -z "${PD_REPO_URL:-}" ]; then
    UPDATE_ERROR="no upstream configured (no $PD_HOME/config.json and no git remote at $UPDATE_SRC)"
    return 1
  fi

  UPDATE_LOCAL_SHA=$(git -C "$UPDATE_SRC" rev-parse HEAD 2>/dev/null) || UPDATE_LOCAL_SHA=
  if [ -z "$UPDATE_LOCAL_SHA" ]; then
    UPDATE_LOCAL_MISSING=1
    UPDATE_ERROR="no local source revision at $UPDATE_SRC — run the pideck installer first"
    return 1
  fi

  if ! command -v gh >/dev/null 2>&1; then
    UPDATE_ERROR="gh CLI not found on PATH — install it (see install/README.md) and authenticate with 'gh auth login'"
    return 1
  fi

  UPDATE_REMOTE_SHA=$(gh api "repos/$UPDATE_REPO/commits/$UPDATE_REF" --jq .sha 2>/dev/null) || UPDATE_REMOTE_SHA=
  if [ -z "$UPDATE_REMOTE_SHA" ]; then
    UPDATE_ERROR="could not read $UPDATE_REPO@$UPDATE_REF via gh api — check 'gh auth status' and the PD_REPO_URL/PD_REPO_REF the installer used"
    return 1
  fi

  return 0
}

# refresh_installed_layer — copy the freshly fetched shell layer over the
# installed one, exactly like bootstrap.sh installs it:
#   install/bin/*            -> $PD_HOME/bin/        (chmod +x, symlink kept)
#   install/lib/*.sh +
#   install/onboard.sh       -> $PD_LIB/            (flat, see issue #65)
# plus a register_service pass so the rendered service unit files
# (launchd plist / systemd unit) are rebuilt from the new $PD_SRC too.
#
# Safe to run from inside a running `pideck update`: the CLI has already
# parsed its copies of common.sh/service.sh/update.sh into memory, so
# overwriting those files on disk mid-run is fine — the refreshed scripts
# take effect on the next shim invocation. Nothing is re-sourced here.
#
# Consumes $PD_SRC (must point at the freshly fetched tree) — call after
# resolve_source, like bootstrap does (bootstrap installs the layer before
# the build so a failed build leaves a recoverable CLI — issue #207).
refresh_installed_layer() {
  step "refreshing the installed shell layer"
  # install_shell_layer also maintains the ~/.local/bin pideck/pideck-daemon
  # entries (issue #215): a stale real-file shim there shadows the refreshed
  # one via PATH, so it is converted to a symlink of the installed shim.
  install_shell_layer "$PD_LIB"
  ok "installed shell layer refreshed (bin, lib, onboard.sh)"
  register_service
}

# short_sha — first 7 chars of a SHA ('' passthrough for empty).
short_sha() {
  printf '%.7s' "$1"
}

# die override (issue #198): remember the message so the apply's EXIT trap
# can write it into the progress file (stage=failed + error). Same output as
# common.sh's die — update.sh is sourced after it, so this wins.
die() {
  UPDATE_APPLY_ERROR=$*
  printf 'error: %s\n' "$*" >&2
  exit 1
}

# update_progress — record the apply stage for the webapp banner (issue #89).
#
# Writes $PD_HOME/var/update-state.json ({"stage":…,"updatedAt":…, ISO UTC});
# the daemon serves it on /api/update so an open webapp shows real progress
# during the multi-minute fetch/rebuild. Best effort only: a failed write
# must never fail the update. Stages (in apply order):
#   checking fetching building installing restarting done failed
# An optional second argument records WHY a stage failed (issue #198: a bare
# `failed` is undebuggable); it is written as the JSON `error` field.
update_progress() { # update_progress <stage> [error-detail]
  _up_dir="$PD_HOME/var"
  mkdir -p "$_up_dir" 2>/dev/null || return 0
  _up_now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [ $# -ge 2 ] && [ -n "$2" ]; then
    # Minimal JSON safety: strip quotes/backslashes, flatten newlines.
    _up_err=$(printf '%s' "$2" | sed -e 's/\\//g' -e 's/"//g' | tr '\n' ' ')
    printf '{"stage":"%s","updatedAt":"%s","error":"%s"}\n' \
      "$1" "$_up_now" "$_up_err" > "$_up_dir/update-state.json.tmp" 2>/dev/null || return 0
  else
    printf '{"stage":"%s","updatedAt":"%s"}\n' \
      "$1" "$_up_now" > "$_up_dir/update-state.json.tmp" 2>/dev/null || return 0
  fi
  mv -f "$_up_dir/update-state.json.tmp" "$_up_dir/update-state.json" 2>/dev/null || return 0
}

# update_apply_failed — EXIT trap for update_apply (issue #198): records the
# failed stage plus the captured reason, if any.
update_apply_failed() {
  update_progress failed "${UPDATE_APPLY_ERROR:-update failed — see ~/.pideck/log/update.log or the terminal output}"
}

# read_running_sha — the build SHA the local daemon last booted with (issue
# #198). The daemon publishes it to $PD_HOME/var/running-sha at startup
# (apps/daemon/src/api/update.ts); empty when unknown (daemon never ran, or
# predates the publication) — callers then fall back to source comparison.
read_running_sha() {
  cat "$PD_HOME/var/running-sha" 2>/dev/null || return 0
}

# update_report — print the check result for humans. Exits 1 on check errors.
update_report() {
  if [ -n "$UPDATE_ERROR" ]; then
    warn "update check failed: $UPDATE_ERROR"
    return 1
  fi
  if [ "$UPDATE_LOCAL_SHA" = "$UPDATE_REMOTE_SHA" ]; then
    UPDATE_RUNNING_SHA=$(read_running_sha)
    if [ -n "$UPDATE_RUNNING_SHA" ] && [ "$UPDATE_RUNNING_SHA" != "$UPDATE_REMOTE_SHA" ]; then
      info "source is current ($(short_sha "$UPDATE_LOCAL_SHA")) but the running daemon is older ($(short_sha "$UPDATE_RUNNING_SHA")) — run 'pideck update' to restart it"
      return 0
    fi
    ok "pideck is up to date ($(short_sha "$UPDATE_LOCAL_SHA") on $UPDATE_REPO@$UPDATE_REF)"
    return 0
  fi
  info "update available: $(short_sha "$UPDATE_LOCAL_SHA") -> $(short_sha "$UPDATE_REMOTE_SHA") (upstream $UPDATE_REPO@$UPDATE_REF)"
  info "run 'pideck update' to fetch, rebuild and restart the service"
  return 0
}

# _node_version_ge moved to common.sh (issue #202: the pi engines check in
# assets.sh needs it too).

# refresh_node_runtime — install the pinned private Node when the private
# runtime is older than $PD_NODE_VERSION (issue #164 follow-up: the pin
# advances with updates, and pi 0.75+ refuses Node < 22.19 — without this an
# updated install keeps booting on a stale runtime, as observed on the dev
# server). Uses deps.sh's tarball installer (idempotent: it skips the
# download when the pinned version already sits in $PD_HOME/opt) and
# repoints the env file's PD_NODE at the refreshed binary. A system node is
# never touched — only installs with a private runtime ($PD_HOME/opt) are
# refreshed; system-node users re-run the installer for a node bump.
refresh_node_runtime() {
  _rn_cur="${PD_NODE:-}"
  if [ ! -x "$_rn_cur" ]; then
    _rn_cur=$(command -v node 2>/dev/null) || _rn_cur=
  fi
  case "$_rn_cur" in
    "$PD_HOME"/opt/*) ;;
    *) return 0 # system node (or none) — updates never touch it
  esac
  _rn_ver=$("$_rn_cur" -v 2>/dev/null) || return 0 # vMAJ.MIN.PATCH
  if _node_version_ge "${_rn_ver#v}" "$PD_NODE_VERSION"; then
    return 0 # private node already meets the pin
  fi
  if [ ! -f "$PD_LIB/deps.sh" ]; then
    warn "$PD_LIB/deps.sh missing — cannot refresh the Node runtime (still on $_rn_ver)"
    return 0
  fi
  step "refreshing the Node runtime ($_rn_ver -> v$PD_NODE_VERSION)"
  # shellcheck disable=SC1090,SC1091 # installed lib dir, sourced on purpose
  . "$PD_LIB/deps.sh"
  _install_node_tarball
  if [ -f "$PD_HOME/env" ]; then
    if grep -q '^PD_NODE=' "$PD_HOME/env"; then
      sed "s|^PD_NODE=.*|PD_NODE=\"$PD_NODE_BIN\"|" "$PD_HOME/env" > "$PD_HOME/env.tmp" 2>/dev/null \
        && mv -f "$PD_HOME/env.tmp" "$PD_HOME/env"
    else
      printf 'PD_NODE="%s"\n' "$PD_NODE_BIN" >> "$PD_HOME/env"
    fi
  fi
  ok "Node runtime refreshed: $("$PD_NODE_BIN" -v) at $PD_NODE_BIN"
  # Issue #202: the env file only reaches FUTURE shim invocations — the
  # apply's own next step (refresh_pi_assets → install_pi_agent) must also
  # resolve the refreshed runtime, so update the live process state too.
  PD_NODE="$PD_NODE_BIN"
  export PD_NODE
  case ":$PATH:" in
    *":$PD_NODE_BIN_DIR:"*) ;;
    *) PATH="$PD_NODE_BIN_DIR:$PATH" ;;
  esac
  export PATH
}

# ensure_pnpm_for_build — the apply's build needs pnpm on PATH (issue #202
# addendum, live on the dev server: bootstrap installs pnpm into the private
# npm prefix, but a fresh shell running `pideck update` can lack it, dying
# with `pnpm: not found` mid-build). Reuses the installer's ensure_pnpm:
# keeps a usable pnpm, else (re)installs the pinned one under the private
# prefix and puts it first on PATH — updates self-heal instead of failing.
ensure_pnpm_for_build() {
  if [ ! -f "$PD_LIB/deps.sh" ]; then
    die "install broken: $PD_LIB/deps.sh missing (re-run the installer)"
  fi
  # shellcheck disable=SC1090,SC1091 # installed lib dir, sourced on purpose
  . "$PD_LIB/deps.sh"
  ensure_pnpm
}

# refresh_pi_assets — reinstall the pi npm package under the ACTIVE node
# (issue #202). Runs AFTER refresh_node_runtime/refresh_installed_layer and
# BEFORE svc_restart: an apply that advances the Node pin must move node and
# pi together (pi lives in $PD_HOME/opt/npm-global under whatever node
# installed it), or the restarted daemon spawns pi sessions against a node
# that cannot run them (pi 0.75+ crashes on Node < 22.19 with
# `zlib.createZstdDecompress is not a function` — observed live on the dev
# server). Sources the freshly installed assets.sh (refresh_installed_layer
# has already copied the fetched tree over $PD_LIB) so the reinstall uses
# the same code the current installer would.
refresh_pi_assets() {
  if [ ! -f "$PD_LIB/assets.sh" ]; then
    warn "$PD_LIB/assets.sh missing — cannot reinstall pi under the active node (re-run the installer)"
    return 0
  fi
  # shellcheck disable=SC1090,SC1091 # installed lib dir, sourced on purpose
  . "$PD_LIB/assets.sh"
  install_pi_agent
}

# update_apply — fetch, rebuild and restart when the upstream ref advanced.
#
# Reuses the installer's own machinery (install/lib/source.sh):
#   resolve_source    → git fetch --depth 1 <ref> + reset --hard, retrying
#                       with gh credentials on failure (_retry_with_gh_auth
#                       semantics, so private repos work)
#   build_from_source → pnpm install --frozen-lockfile && pnpm build
# then refreshes the installed shell layer (lib/*.sh + onboard.sh, bin/*,
# service unit files — issue #66: fixes to the install scripts itself must
# reach machines that update via the CLI) and restarts the persistent
# service via svc_restart (service.sh).
#
# Issue #198: the "already up to date" comparison is against the RUNNING
# build (read_running_sha), not just the source — a previous apply can die
# between the source reset and the restart, leaving the source current while
# the daemon still serves the old build; that state restarts (no fetch or
# rebuild needed) instead of reporting done.
#
# No-op (exit 0) when the running build already matches the upstream ref —
# no unnecessary rebuilds.
update_apply() {
  UPDATE_APPLY_ERROR=
  UPDATE_SELF_HEALED=
  # Progress file (issue #89): the webapp banner reads the stage live. On any
  # death (die/kill of the shim), the EXIT trap records `failed` — with the
  # reason when one was captured (issue #198) — unless we reached `done`,
  # which clears the trap first.
  trap update_apply_failed EXIT
  update_progress checking
  step "checking for updates"
  if ! update_check; then
    # Issue #221: a missing or corrupt source checkout (crashed apply debris,
    # wiped ~/.pideck/src) must self-heal instead of erroring forever — the
    # installer machinery already re-clones a missing checkout, so reuse it
    # for corrupt ones: drop the broken tree and clone afresh. Only possible
    # when an upstream URL is known (config.json or the old clone's remote).
    if [ "${UPDATE_LOCAL_MISSING:-}" = "1" ] && [ -n "${PD_REPO_URL:-}" ] && [ -f "$PD_LIB/source.sh" ]; then
      warn "source checkout at $UPDATE_SRC is missing or corrupt — re-cloning to self-heal"
      # shellcheck disable=SC1090,SC1091 # installed lib dir, sourced on purpose
      . "$PD_LIB/source.sh"
      PD_SRC=$UPDATE_SRC
      PD_REPO_REF=$UPDATE_REF
      update_progress fetching
      step "re-cloning $UPDATE_REPO@$UPDATE_REF (the old checkout was unusable)"
      run_ignore rm -rf "$PD_SRC"
      resolve_source
      if ! update_check; then
        UPDATE_APPLY_ERROR="update check failed: $UPDATE_ERROR"
        warn "cannot apply an update: $UPDATE_ERROR"
        return 1
      fi
      UPDATE_SELF_HEALED=1
    else
      UPDATE_APPLY_ERROR="update check failed: $UPDATE_ERROR"
      warn "cannot apply an update: $UPDATE_ERROR"
      return 1
    fi
  fi
  UPDATE_RUNNING_SHA=$(read_running_sha)
  UPDATE_NEEDS_BUILD=
  if [ "$UPDATE_LOCAL_SHA" = "$UPDATE_REMOTE_SHA" ]; then
    if [ -z "$UPDATE_RUNNING_SHA" ] || [ "$UPDATE_RUNNING_SHA" = "$UPDATE_REMOTE_SHA" ]; then
      if [ -z "$UPDATE_SELF_HEALED" ]; then
        update_report
        update_progress "done"
        trap - EXIT
        return 0
      fi
      # Self-healed checkout with the daemon already running the upstream
      # build: the fresh clone has no build artifacts and the installed
      # layer predates it — rebuild and refresh instead of reporting done.
      UPDATE_NEEDS_BUILD=1
      info "self-healed checkout is current — rebuilding the fresh clone"
    fi
    if [ -z "$UPDATE_NEEDS_BUILD" ]; then
      info "source is current, but the daemon still runs $(short_sha "$UPDATE_RUNNING_SHA") — restarting to pick it up"
    fi
  else
    info "update available: $(short_sha "$UPDATE_LOCAL_SHA") -> $(short_sha "$UPDATE_REMOTE_SHA") (upstream $UPDATE_REPO@$UPDATE_REF)"
    [ -f "$PD_LIB/source.sh" ] || die "install broken: $PD_LIB/source.sh missing (re-run the installer)"
    # shellcheck disable=SC1090,SC1091 # installed lib dir, sourced on purpose
    . "$PD_LIB/source.sh"
    PD_SRC=$UPDATE_SRC
    update_progress fetching
    step "fetching new source ($UPDATE_REPO@$UPDATE_REF)"
    resolve_source
    UPDATE_NEEDS_BUILD=1
  fi
  if [ -n "$UPDATE_NEEDS_BUILD" ]; then
    update_progress building
    # Issue #213: build with the install's own runtime, not whatever node
    # happens to be first on PATH — the old shim never put the private node
    # dir on PATH, so the suite/build ran under a random PATH node (observed
    # live: the webapp vite build died instantly). The shim always derives
    # PD_NODE_BIN_DIR now; when update.sh runs without it (direct sourcing),
    # leave PATH alone rather than guess.
    if [ -n "${PD_NODE_BIN_DIR:-}" ]; then
      case ":$PATH:" in
        *":$PD_NODE_BIN_DIR:"*) ;;
        *) PATH="$PD_NODE_BIN_DIR:$PATH" ;;
      esac
      export PATH
    fi
    ensure_pnpm_for_build
    build_from_source
  fi
  update_progress installing
  # Issue #202 ordering: refresh the private node FIRST, reinstall the pi
  # assets under it SECOND (after the shell layer refresh has put the fresh
  # assets.sh in place), restart the daemon LAST — node and pi move together
  # or not at all.
  refresh_node_runtime
  refresh_installed_layer
  refresh_pi_assets
  update_progress restarting
  step "restarting the service"
  svc_restart
  update_progress "done"
  trap - EXIT
  ok "update applied — pideck now runs $(short_sha "$(git -C "$PD_SRC" rev-parse HEAD)")"
}
