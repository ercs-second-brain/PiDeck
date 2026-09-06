# shellcheck shell=sh
#
# Source resolution + build for the agentskiss installer.
#
# AK_SRC ends up pointing at a checkout of the monorepo containing:
#   apps/daemon/  apps/web/  packages/  agent/  install/

# ---------------------------------------------------------------------------
# resolve_source
#
# Decides where the monorepo source comes from, in order:
#   1. --dir / AK_SRC_DIR: a user-provided checkout (also used by the
#      `curl | sh` path after it unpacked the repo tarball itself)
#   2. a (re)used or fresh git clone at $AK_HOME/src
# ---------------------------------------------------------------------------
resolve_source() {
  if [ -n "${AK_SRC_DIR:-}" ]; then
    [ -d "$AK_SRC_DIR/apps/daemon" ] || die "--dir $AK_SRC_DIR does not look like the agentskiss monorepo"
    AK_SRC=$AK_SRC_DIR
    ok "using source at $AK_SRC"
    return 0
  fi

  AK_SRC="$AK_HOME/src"
  if [ -d "$AK_SRC/.git" ]; then
    step "updating existing clone at $AK_SRC"
    if ! run git -C "$AK_SRC" fetch --depth 1 origin "$AK_REPO_REF"; then
      _retry_with_gh_auth || die "could not update $AK_SRC"
      run git -C "$AK_SRC" fetch --depth 1 origin "$AK_REPO_REF"
    fi
    run git -C "$AK_SRC" reset --hard FETCH_HEAD
  else
    step "cloning $AK_REPO_URL ($AK_REPO_REF)"
    run_ignore rm -rf "$AK_SRC"
    if ! run git clone --depth 1 --branch "$AK_REPO_REF" "$AK_REPO_URL" "$AK_SRC"; then
      info "clone failed — retrying with gh credentials (private repo?)"
      _retry_with_gh_auth || die "could not clone $AK_REPO_URL — authenticate first (gh auth login or GH_TOKEN), then re-run"
      run_ignore rm -rf "$AK_SRC"
      run git clone --depth 1 --branch "$AK_REPO_REF" "$AK_REPO_URL" "$AK_SRC"
    fi
  fi
  ok "source ready at $AK_SRC"
}

# Wire git to gh's credential store so private-repo clones work on fresh
# machines. Dies when gh itself has no auth yet.
_retry_with_gh_auth() {
  command -v gh >/dev/null 2>&1 || return 1
  gh auth status >/dev/null 2>&1 || return 1
  warn "using gh's GitHub credentials for git"
  run gh auth setup-git
}

# ---------------------------------------------------------------------------
# build_from_source
#
# THE single place that produces the daemon/webapp build artifacts consumed
# by the service units. Today: pnpm install + pnpm build from a git clone of
# this monorepo. When release artifacts (tarball with prebuilt dist/ or
# packaged binaries) become available, replace ONLY this function with the
# release-download path — the rest of the installer already consumes the
# well-known layout it must keep producing:
#
#   $AK_SRC/apps/daemon/dist/index.js   (daemon entry: exports main())
#   $AK_SRC/apps/web/dist/…             (webapp assets)
#   $AK_SRC/agent/…                     (pi skills/extensions sources)
#
# Requires: node >= 22 and pnpm on PATH (see ensure_node / ensure_pnpm).
# ---------------------------------------------------------------------------
build_from_source() {
  step "building agentskiss from source at $AK_SRC"
  if [ "$AK_DRY_RUN" = "1" ] && [ ! -d "$AK_SRC" ]; then
    printf "[dry-run] (cd %s && pnpm install --frozen-lockfile && pnpm build)\n" "$AK_SRC"
    return 0
  fi
  (
    cd "$AK_SRC" || exit 1
    run pnpm install --frozen-lockfile
    run pnpm build
  ) || die "build failed"
  [ -f "$AK_SRC/apps/daemon/dist/index.js" ] || die "build produced no daemon entry at apps/daemon/dist/index.js"
  ok "build complete"
}
