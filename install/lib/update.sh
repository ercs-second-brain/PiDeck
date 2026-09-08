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
#   UPDATE_REPO        owner/name (or the raw URL when it has no slug)
#   UPDATE_REF         tracked upstream ref
#   UPDATE_ERROR       human-readable failure detail ('' on success)
#
# Returns 0 when both revisions resolved, 1 otherwise (UPDATE_ERROR explains).
update_check() {
  UPDATE_LOCAL_SHA=
  UPDATE_REMOTE_SHA=
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
# resolve_source/build_from_source, like bootstrap does.
refresh_installed_layer() {
  step "refreshing the installed shell layer"
  install_shell_layer "$PD_LIB"
  ok "installed shell layer refreshed (bin, lib, onboard.sh)"
  register_service
}

# short_sha — first 7 chars of a SHA ('' passthrough for empty).
short_sha() {
  printf '%.7s' "$1"
}

# update_progress — record the apply stage for the webapp banner (issue #89).
#
# Writes $PD_HOME/var/update-state.json ({"stage":…,"updatedAt":…, ISO UTC});
# the daemon serves it on /api/update so an open webapp shows real progress
# during the multi-minute fetch/rebuild. Best effort only: a failed write
# must never fail the update. Stages (in apply order):
#   checking fetching building installing restarting done failed
update_progress() {
  _up_dir="$PD_HOME/var"
  mkdir -p "$_up_dir" 2>/dev/null || return 0
  printf '{"stage":"%s","updatedAt":"%s"}\n' \
    "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$_up_dir/update-state.json.tmp" 2>/dev/null || return 0
  mv -f "$_up_dir/update-state.json.tmp" "$_up_dir/update-state.json" 2>/dev/null || return 0
}

# update_report — print the check result for humans. Exits 1 on check errors.
update_report() {
  if [ -n "$UPDATE_ERROR" ]; then
    warn "update check failed: $UPDATE_ERROR"
    return 1
  fi
  if [ "$UPDATE_LOCAL_SHA" = "$UPDATE_REMOTE_SHA" ]; then
    ok "pideck is up to date ($(short_sha "$UPDATE_LOCAL_SHA") on $UPDATE_REPO@$UPDATE_REF)"
    return 0
  fi
  info "update available: $(short_sha "$UPDATE_LOCAL_SHA") -> $(short_sha "$UPDATE_REMOTE_SHA") (upstream $UPDATE_REPO@$UPDATE_REF)"
  info "run 'pideck update' to fetch, rebuild and restart the service"
  return 0
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
# No-op (exit 0) when already up to date — no unnecessary rebuilds.
update_apply() {
  # Progress file (issue #89): the webapp banner reads the stage live. On any
  # death (die/kill of the shim), the EXIT trap records `failed` — unless we
  # reached `done`, which clears the trap first.
  trap 'update_progress failed' EXIT
  update_progress checking
  step "checking for updates"
  if ! update_check; then
    warn "cannot apply an update: $UPDATE_ERROR"
    return 1
  fi
  update_report || return 1
  if [ "$UPDATE_LOCAL_SHA" = "$UPDATE_REMOTE_SHA" ]; then
    update_progress "done"
    trap - EXIT
    return 0
  fi

  [ -f "$PD_LIB/source.sh" ] || die "install broken: $PD_LIB/source.sh missing (re-run the installer)"
  # shellcheck disable=SC1090,SC1091 # installed lib dir, sourced on purpose
  . "$PD_LIB/source.sh"
  PD_SRC=$UPDATE_SRC
  update_progress fetching
  step "fetching new source ($UPDATE_REPO@$UPDATE_REF)"
  resolve_source
  update_progress building
  build_from_source
  update_progress installing
  refresh_installed_layer
  update_progress restarting
  step "restarting the service"
  svc_restart
  update_progress "done"
  trap - EXIT
  ok "update applied — pideck now runs $(short_sha "$(git -C "$PD_SRC" rev-parse HEAD)")"
}
