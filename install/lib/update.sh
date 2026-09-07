# shellcheck shell=sh
#
# Self-update check/apply for the agentskiss CLI (issue #55).
#
# Sourced by install/bin/agentskiss after common.sh (needs AK_HOME, AK_LIB
# and the logging/run helpers). Pairs with install/lib/source.sh, whose
# resolve_source/build_from_source the apply path reuses so private repos
# and dev refs update exactly like installer runs do.
#
# Check semantics (shared with the daemon's /api/update, apps/daemon/src/api/update.ts):
#   - local revision:  git -C $AK_SRC rev-parse HEAD
#   - upstream head:   gh api repos/:owner/:repo/commits/<ref>  (--jq .sha)
#   - repo/ref:        $AK_HOME/config.json (the installer's record) with a
#                      git-remote fallback, so private repos and non-main
#                      dev refs check like public ones.

# The installed source checkout (AGENTSKISS_SRC is exported by $AK_HOME/env).
UPDATE_SRC="${AGENTSKISS_SRC:-$AK_HOME/src}"

# Read repoUrl/repoRef from $AK_HOME/config.json into AK_REPO_URL/AK_REPO_REF.
# No-op (returns 1) when the file or a field is missing — callers then fall
# back to the git remote / common.sh defaults.
load_repo_config() {
  _lrc_file="$AK_HOME/config.json"
  [ -f "$_lrc_file" ] || return 1
  _lrc_url=$(sed -n 's/.*"repoUrl"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_lrc_file")
  _lrc_ref=$(sed -n 's/.*"repoRef"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$_lrc_file")
  [ -n "$_lrc_url" ] || return 1
  AK_REPO_URL=$_lrc_url
  [ -n "$_lrc_ref" ] && AK_REPO_REF=$_lrc_ref
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
    UPDATE_REF=${AK_REPO_REF:-main}
  elif [ -d "$UPDATE_SRC/.git" ]; then
    # No installer config (dev checkout): track what the clone tracks.
    AK_REPO_URL=$(git -C "$UPDATE_SRC" remote get-url origin 2>/dev/null) || AK_REPO_URL=
    UPDATE_REF=${AK_REPO_REF:-main}
  else
    UPDATE_REF=${AK_REPO_REF:-main}
  fi

  _uc_slug=$(repo_slug "${AK_REPO_URL:-}")
  if [ -n "$_uc_slug" ]; then
    UPDATE_REPO=$_uc_slug
  else
    UPDATE_REPO=${AK_REPO_URL:-unknown}
  fi

  if [ -z "${AK_REPO_URL:-}" ]; then
    UPDATE_ERROR="no upstream configured (no $AK_HOME/config.json and no git remote at $UPDATE_SRC)"
    return 1
  fi

  UPDATE_LOCAL_SHA=$(git -C "$UPDATE_SRC" rev-parse HEAD 2>/dev/null) || UPDATE_LOCAL_SHA=
  if [ -z "$UPDATE_LOCAL_SHA" ]; then
    UPDATE_ERROR="no local source revision at $UPDATE_SRC — run the agentskiss installer first"
    return 1
  fi

  if ! command -v gh >/dev/null 2>&1; then
    UPDATE_ERROR="gh CLI not found on PATH — install it (see install/README.md) and authenticate with 'gh auth login'"
    return 1
  fi

  UPDATE_REMOTE_SHA=$(gh api "repos/$UPDATE_REPO/commits/$UPDATE_REF" --jq .sha 2>/dev/null) || UPDATE_REMOTE_SHA=
  if [ -z "$UPDATE_REMOTE_SHA" ]; then
    UPDATE_ERROR="could not read $UPDATE_REPO@$UPDATE_REF via gh api — check 'gh auth status' and the AGENTSKISS_REPO_URL/AGENTSKISS_REPO_REF the installer used"
    return 1
  fi

  return 0
}

# short_sha — first 7 chars of a SHA ('' passthrough for empty).
short_sha() {
  printf '%.7s' "$1"
}

# update_report — print the check result for humans. Exits 1 on check errors.
update_report() {
  if [ -n "$UPDATE_ERROR" ]; then
    warn "update check failed: $UPDATE_ERROR"
    return 1
  fi
  if [ "$UPDATE_LOCAL_SHA" = "$UPDATE_REMOTE_SHA" ]; then
    ok "agentskiss is up to date ($(short_sha "$UPDATE_LOCAL_SHA") on $UPDATE_REPO@$UPDATE_REF)"
    return 0
  fi
  info "update available: $(short_sha "$UPDATE_LOCAL_SHA") -> $(short_sha "$UPDATE_REMOTE_SHA") (upstream $UPDATE_REPO@$UPDATE_REF)"
  info "run 'agentskiss update' to fetch, rebuild and restart the service"
  return 0
}

# update_apply — fetch, rebuild and restart when the upstream ref advanced.
#
# Reuses the installer's own machinery (install/lib/source.sh):
#   resolve_source    → git fetch --depth 1 <ref> + reset --hard, retrying
#                       with gh credentials on failure (_retry_with_gh_auth
#                       semantics, so private repos work)
#   build_from_source → pnpm install --frozen-lockfile && pnpm build
# then restarts the persistent service via svc_restart (service.sh).
#
# No-op (exit 0) when already up to date — no unnecessary rebuilds.
update_apply() {
  step "checking for updates"
  if ! update_check; then
    warn "cannot apply an update: $UPDATE_ERROR"
    return 1
  fi
  update_report || return 1
  if [ "$UPDATE_LOCAL_SHA" = "$UPDATE_REMOTE_SHA" ]; then
    return 0
  fi

  [ -f "$AK_LIB/source.sh" ] || die "install broken: $AK_LIB/source.sh missing (re-run the installer)"
  # shellcheck disable=SC1090,SC1091 # installed lib dir, sourced on purpose
  . "$AK_LIB/source.sh"
  AK_SRC=$UPDATE_SRC
  step "fetching new source ($UPDATE_REPO@$UPDATE_REF)"
  resolve_source
  build_from_source
  step "restarting the service"
  svc_restart
  ok "update applied — agentskiss now runs $(short_sha "$(git -C "$AK_SRC" rev-parse HEAD)")"
}
