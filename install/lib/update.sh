# shellcheck shell=sh
#
# Self-update for the pideck CLI.
#
# Sourced by install/bin/pideck after common.sh (needs PD_HOME, PD_LIB and
# the logging/run helpers). Reuses install/lib/source.sh: resolve_source for
# the fetch and build_from_source for the rebuild, then refreshes the
# installed shell layer (bin + lib + service unit files) and restarts the
# service. A no-op when the local checkout is already at the tracked ref.

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

# update_check — compare the local source HEAD with the upstream ref head.
#
# Sets: UPDATE_LOCAL_SHA, UPDATE_REMOTE_SHA, UPDATE_REF, UPDATE_URL.
# Returns nonzero (with a warn) when the comparison cannot be made.
update_check() {
  UPDATE_LOCAL_SHA=
  UPDATE_REMOTE_SHA=

  if ! load_repo_config; then
    if [ -d "$UPDATE_SRC/.git" ]; then
      # No installer config (dev checkout): track what the clone tracks.
      PD_REPO_URL=$(git -C "$UPDATE_SRC" remote get-url origin 2>/dev/null) || PD_REPO_URL=
    fi
  fi
  UPDATE_URL=${PD_REPO_URL:-}
  UPDATE_REF=${PD_REPO_REF:-main}

  if [ -z "$UPDATE_URL" ]; then
    warn "no upstream configured (no $PD_HOME/config.json and no git remote at $UPDATE_SRC)"
    return 1
  fi

  UPDATE_LOCAL_SHA=$(git -C "$UPDATE_SRC" rev-parse HEAD 2>/dev/null) || UPDATE_LOCAL_SHA=
  if [ -z "$UPDATE_LOCAL_SHA" ]; then
    warn "no local source revision at $UPDATE_SRC — run the pideck installer first"
    return 1
  fi

  UPDATE_REMOTE_SHA=$(git ls-remote "$UPDATE_URL" "refs/heads/$UPDATE_REF" | cut -f1 | head -n 1)
  if [ -z "$UPDATE_REMOTE_SHA" ]; then
    # Not a branch (or fetch blocked) — try a tag of the same name.
    UPDATE_REMOTE_SHA=$(git ls-remote "$UPDATE_URL" "refs/tags/$UPDATE_REF" | cut -f1 | head -n 1)
  fi
  if [ -z "$UPDATE_REMOTE_SHA" ]; then
    warn "could not read $UPDATE_URL@$UPDATE_REF — check network and credentials"
    return 1
  fi
  return 0
}

# refresh_installed_layer — copy the freshly fetched shell layer over the
# installed one, exactly like bootstrap.sh installs it:
#   install/bin/*            -> $PD_HOME/bin/        (chmod +x, symlink kept)
#   install/lib/*.sh +
#   install/onboard.sh       -> $PD_LIB/             (flat)
# plus a register_service pass so the rendered service unit files
# (launchd plist / systemd unit) are rebuilt from the new $PD_SRC too.
#
# Safe to run from inside a running `pideck update`: the CLI has already
# parsed its copies of common.sh/service.sh/update.sh into memory, so
# overwriting those files on disk mid-run is fine — the refreshed scripts
# take effect on the next shim invocation. Nothing is re-sourced here.
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

# update_apply — fetch, rebuild, refresh the installed layer and restart the
# service when the upstream ref advanced; a no-op when already at the ref.
update_apply() {
  step "checking for updates"
  if ! update_check; then
    return 1
  fi
  if [ "$UPDATE_LOCAL_SHA" = "$UPDATE_REMOTE_SHA" ]; then
    ok "pideck is up to date ($(short_sha "$UPDATE_LOCAL_SHA") on $UPDATE_URL@$UPDATE_REF)"
    return 0
  fi

  info "update available: $(short_sha "$UPDATE_LOCAL_SHA") -> $(short_sha "$UPDATE_REMOTE_SHA") (upstream $UPDATE_URL@$UPDATE_REF)"
  [ -f "$PD_LIB/source.sh" ] || die "install broken: $PD_LIB/source.sh missing (re-run the installer)"
  # shellcheck disable=SC1090,SC1091 # installed lib dir, sourced on purpose
  . "$PD_LIB/source.sh"

  step "fetching new source ($UPDATE_URL@$UPDATE_REF)"
  PD_SRC=$UPDATE_SRC
  resolve_source

  # Build with the install's own runtime, not whatever node happens to be
  # first on PATH.
  if [ -n "${PD_NODE_BIN_DIR:-}" ]; then
    case ":$PATH:" in
      *":$PD_NODE_BIN_DIR:"*) ;;
      *) PATH="$PD_NODE_BIN_DIR:$PATH" ;;
    esac
    export PATH
  fi
  if [ ! -f "$PD_LIB/deps.sh" ]; then
    die "install broken: $PD_LIB/deps.sh missing (re-run the installer)"
  fi
  # shellcheck disable=SC1090,SC1091 # installed lib dir, sourced on purpose
  . "$PD_LIB/deps.sh"
  ensure_pnpm
  build_from_source

  refresh_installed_layer

  step "restarting the service"
  svc_restart
  ok "update applied — pideck now runs $(short_sha "$(git -C "$PD_SRC" rev-parse HEAD)")"
}
