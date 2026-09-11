# shellcheck shell=sh
#
# Source resolution + build for the pideck installer.
#
# PD_SRC ends up pointing at a checkout of the monorepo containing:
#   apps/daemon/  apps/web/  packages/  agent/  install/

# ---------------------------------------------------------------------------
# resolve_source
#
# Decides where the monorepo source comes from, in order:
#   1. --dir / PD_SRC_DIR: a user-provided checkout (also used by the
#      `curl | sh` path after it unpacked the repo tarball itself)
#   2. a (re)used or fresh git clone at $PD_HOME/src
#
# Repo rename (issue #125): agentsKISS -> PiDeck. GitHub redirects renamed
# repos, so an existing clone whose origin still points at
# https://github.com/ercs-second-brain/agentsKISS.git keeps fetching from
# here (`git fetch` follows the redirect), and config.json records of the old
# URL keep working — see install/lib/update.sh. New installs clone the new
# https://github.com/ercs-second-brain/PiDeck.git URL (lib/common.sh default).
# ---------------------------------------------------------------------------
resolve_source() {
  if [ -n "${PD_SRC_DIR:-}" ]; then
    [ -d "$PD_SRC_DIR/apps/daemon" ] || die "--dir $PD_SRC_DIR does not look like the pideck monorepo"
    PD_SRC=$PD_SRC_DIR
    ok "using source at $PD_SRC"
    return 0
  fi

  PD_SRC="$PD_HOME/src"
  if [ -d "$PD_SRC/.git" ]; then
    step "updating existing clone at $PD_SRC"
    if ! run git -C "$PD_SRC" fetch --depth 1 origin "$PD_REPO_REF"; then
      _retry_with_gh_auth || die "could not update $PD_SRC"
      run git -C "$PD_SRC" fetch --depth 1 origin "$PD_REPO_REF"
    fi
    run git -C "$PD_SRC" reset --hard FETCH_HEAD
  else
    step "cloning $PD_REPO_URL ($PD_REPO_REF)"
    run_ignore rm -rf "$PD_SRC"
    if ! run git clone --depth 1 --branch "$PD_REPO_REF" "$PD_REPO_URL" "$PD_SRC"; then
      info "clone failed — retrying with gh credentials (private repo?)"
      _retry_with_gh_auth || die "could not clone $PD_REPO_URL — authenticate first (gh auth login or GH_TOKEN), then re-run"
      run_ignore rm -rf "$PD_SRC"
      run git clone --depth 1 --branch "$PD_REPO_REF" "$PD_REPO_URL" "$PD_SRC"
    fi
  fi
  ok "source ready at $PD_SRC"
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
#   $PD_SRC/apps/daemon/dist/index.js   (daemon entry: exports main())
#   $PD_SRC/apps/web/dist/…             (webapp assets)
#   $PD_SRC/agent/…                     (pi skills/extensions sources)
#
# Requires: node >= 22 and pnpm on PATH (see ensure_node / ensure_pnpm).
# ---------------------------------------------------------------------------
build_from_source() {
  step "building pideck from source at $PD_SRC"
  if [ "$PD_DRY_RUN" = "1" ] && [ ! -d "$PD_SRC" ]; then
    printf "[dry-run] (cd %s && pnpm install --frozen-lockfile && pnpm build)\n" "$PD_SRC"
    return 0
  fi
  (
    cd "$PD_SRC" || exit 1
    # Issue #484: this function runs inside the installer's / the update
    # apply's process, whose environment exports the whole PD_* namespace
    # (PD_HOME, PD_SRC, PD_PI_DIR, PD_NODE*, … — common.sh, update.sh). The
    # build's `pnpm -r build` runs install/'s plain-shell test suite, whose
    # fixtures pin their OWN PD_* values — the leaked ambient PD_PI_DIR made
    # the asset-reconcile test (#460 follow-up) link its fixture skills into
    # the REAL agent dir and fail, so every apply/bootstrap build died with
    # "build failed" on the box while CI (no ambient PD_*) stayed green.
    # Strip the installer variables so the build sees a CI-like environment;
    # PATH, HOME and network settings pass through untouched.
    _bf_scrub=$(printenv | sed -n 's/^\(PD_[A-Za-z0-9_]*\)=.*/-u \1/p; s/^\(UPDATE_[A-Za-z0-9_]*\)=.*/-u \1/p')
    # shellcheck disable=SC2046,SC2086 # -u NAME flags: bare names, safe to split
    run env $_bf_scrub pnpm install --frozen-lockfile
    # shellcheck disable=SC2046,SC2086 # -u NAME flags: bare names, safe to split
    run env $_bf_scrub pnpm build
  ) || die "build failed"
  [ -f "$PD_SRC/apps/daemon/dist/index.js" ] || die "build produced no daemon entry at apps/daemon/dist/index.js"
  ok "build complete"
}
