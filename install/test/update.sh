#!/bin/sh
# Plain-shell tests for the self-update flow (issue #55): the check logic in
# install/lib/update.sh with fake git/gh on PATH, plus the install/bin/pideck
# shim wiring for `update --check` and the apply path's reuse of the installer
# machinery (resolve_source/build_from_source + svc_restart). No network, no
# real git/gh, no real service.
#
# SC2016: the run_update snippets are single-quoted ON PURPOSE — they must
# expand inside the test shell that sources update.sh, not here.
# shellcheck shell=sh disable=SC2016,SC2154 # SC2016: snippets expand in the sourced sub-shell; SC2154: failures comes from harness.sh
set -u

# shellcheck disable=SC1091 # shared test harness, sourced on purpose
. "$(dirname -- "$0")/harness.sh"

LOCAL_SHA="1111111111111111111111111111111111111111"
REMOTE_SAME="$LOCAL_SHA"
REMOTE_NEW="2222222222222222222222222222222222222222"

# --- install layout under test ---------------------------------------------
PD_HOME="$tmp/home"
PD_SRC="$PD_HOME/src"
mkdir -p "$PD_HOME/lib" "$PD_HOME/bin" "$PD_SRC/.git"
cp "$INSTALL_DIR/lib/common.sh" "$INSTALL_DIR/lib/source.sh" "$INSTALL_DIR/lib/update.sh" "$PD_HOME/lib/"
cat > "$PD_HOME/lib/service.sh" <<'EOF'
svc_restart() { printf 'SVC restart\n'; cp "$PD_HOME/var/update-state.json" "$PD_HOME/var/restart-stage.snapshot" 2>/dev/null; }
register_service() { printf 'REGISTER service\n'; }
EOF

# env file (as bootstrap writes it) + config.json pointing at a private repo/ref
cat > "$PD_HOME/env" <<EOF
PD_HOME="$PD_HOME"
PD_SRC="$PD_SRC"
PD_NODE="$tmp/fake-node"
PD_WEB_PORT="8321"
PD_WEB_HOST="0.0.0.0"
EOF
write_config() {
  cat > "$PD_HOME/config.json" <<'EOF'
{
  "installedAt": "2026-01-01T00:00:00Z",
  "repoUrl": "https://github.com/acme/private-dev.git",
  "repoRef": "dev-branch"
}
EOF
}
write_config

# --- fake git/gh ------------------------------------------------------------
# git: rev-parse HEAD → $FAKE_LOCAL_SHA; remote get-url origin → $FAKE_REMOTE_URL.
# gh:  api repos/<slug>/commits/<ref> --jq .sha → $FAKE_REMOTE_SHA.
FAKE_BIN="$tmp/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/git" <<'EOF'
#!/bin/sh
# Skip git's global -C <dir> pairs before dispatching on the subcommand.
while [ "$1" = "-C" ]; do shift 2; done
case "$1" in
  rev-parse) [ -n "$FAKE_LOCAL_SHA" ] && { printf '%s\n' "$FAKE_LOCAL_SHA"; exit 0; }; exit 128 ;;
  remote) [ -n "$FAKE_REMOTE_URL" ] && { printf '%s\n' "$FAKE_REMOTE_URL"; exit 0; }; exit 2 ;;
  *) exit 64 ;;
esac
EOF
cat > "$FAKE_BIN/gh" <<'EOF'
#!/bin/sh
[ "$1" = "api" ] || exit 64
[ -n "$FAKE_REMOTE_SHA" ] && { printf '%s\n' "$FAKE_REMOTE_SHA"; exit 0; }
printf 'gh: not authenticated\n' >&2
exit 4
EOF
chmod +x "$FAKE_BIN/git" "$FAKE_BIN/gh"

# Runs an update.sh snippet with the fake git/gh and the fake install layout.
# Usage: run_update <local-sha> <remote-sha|''> <remote-url|''> <snippet>
# HOME is pinned to the fake home so ~/.local/bin writes (the pideck
# symlink the apply path re-creates) land in the tmp tree, not the real one.
run_update() {
  env PATH="$FAKE_BIN:$PATH" \
    FAKE_LOCAL_SHA="$1" FAKE_REMOTE_SHA="$2" FAKE_REMOTE_URL="$3" UPDATE_SNIPPET="$4" \
    PD_HOME="$PD_HOME" HOME="$PD_HOME" \
    sh -c '
      set -u
      set -a; . "$PD_HOME/env"; set +a
      . "$PD_HOME/lib/common.sh"
      detect_os
      . "$PD_HOME/lib/update.sh"
      eval "$UPDATE_SNIPPET"
  '
}

# --- check logic (update.sh, mock git/gh) -----------------------------------

out=$(run_update "$LOCAL_SHA" "$REMOTE_SAME" "" 'update_check; update_report'); rc=$?
check_eq 'up-to-date check exits 0' '0' "$rc"
check_grep 'up-to-date message printed' 'up to date' "$out"
check_grep 'up-to-date reports the short sha' '1111111' "$out"
check_grep 'up-to-date reports the private repo slug and ref' 'acme/private-dev@dev-branch' "$out"

out=$(run_update "$LOCAL_SHA" "$REMOTE_NEW" "" 'update_check; update_report'); rc=$?
check_eq 'update-available check exits 0' '0' "$rc"
check_grep 'update available message printed' 'update available' "$out"
check_grep 'update available shows old -> new' '1111111 -> 2222222' "$out"
check_grep 'update available suggests the apply command' 'pideck update' "$out"

out=$(run_update "$LOCAL_SHA" "" "" 'update_check; update_report' 2>&1); rc=$?
check_eq 'gh failure exits nonzero' '1' "$rc"
check_grep 'gh failure explains auth' 'gh auth status' "$out"

out=$(run_update "" "$REMOTE_NEW" "" 'update_check; update_report' 2>&1); rc=$?
check_eq 'missing local source exits nonzero' '1' "$rc"
check_grep 'missing local source explained' 'no local source revision' "$out"

out=$(run_update "$LOCAL_SHA" "$REMOTE_NEW" "" 'update_check; printf "%s" "$UPDATE_REPO:$UPDATE_REF"')
check_eq 'repo/ref resolved from the installer config' 'acme/private-dev:dev-branch' "$out"

# no config.json → git remote fallback (ssh URL), ref defaults to main
rm -f "$PD_HOME/config.json"
out=$(run_update "$LOCAL_SHA" "$REMOTE_NEW" "git@github.com:dev/fork.git" 'update_check; printf "%s" "$UPDATE_REPO:$UPDATE_REF"')
check_eq 'git remote fallback yields ssh slug + main ref' 'dev/fork:main' "$out"
write_config

# --- shim wiring ------------------------------------------------------------

run_shim() { # run_shim <local-sha> <remote-sha|''> <args...>
  _rs_local=$1; _rs_remote=$2; shift 2
  env PATH="$FAKE_BIN:$PATH" FAKE_LOCAL_SHA="$_rs_local" FAKE_REMOTE_SHA="$_rs_remote" \
    PD_HOME="$PD_HOME" HOME="$PD_HOME" sh "$SHIM" "$@"
}

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update --check)
check_grep 'shim update --check reports up to date' 'up to date' "$out"
check_no_grep 'shim update --check is not forwarded to the daemon CLI' 'DAEMON-CLI' "$out"

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" help)
check_grep 'help documents the update verb' 'update [--check]' "$out"

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update bogus 2>&1); rc=$?
check_eq 'unknown update command exits 1' '1' "$rc"
check_grep 'unknown update command usage error' 'usage: pideck update' "$out"

# --- apply path (up to date → no rebuild, no restart) -----------------------

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update); rc=$?
check_eq 'apply when up to date exits 0' '0' "$rc"
check_no_grep 'apply when up to date does not restart the service' 'SVC restart' "$out"
check_grep 'apply when up to date says so' 'up to date' "$out"
check_grep 'apply when up to date records done progress (issue #89)' '"stage":"done"' "$(cat "$PD_HOME/var/update-state.json")"

# --- apply path (update available → fetch, build, restart) ------------------
# Stub the installer machinery here: the real resolve_source/build_from_source
# need network + pnpm; the flow under test is *that they are reused*, in
# order, with the configured ref, and that svc_restart runs after them.
cat > "$PD_HOME/lib/source.sh" <<'EOF'
resolve_source() { printf 'RESOLVE fetch %s\n' "$PD_REPO_REF"; }
build_from_source() { printf 'BUILD\n'; cp "$PD_HOME/var/update-state.json" "$PD_HOME/var/build-stage.snapshot" 2>/dev/null; }
EOF
rm -f "$PD_HOME/var/update-state.json"
out=$(run_shim "$LOCAL_SHA" "$REMOTE_NEW" update); rc=$?
check_eq 'apply with update available exits 0' '0' "$rc"
check_grep 'apply fetches the configured ref' 'RESOLVE fetch dev-branch' "$out"
check_grep 'apply rebuilds via build_from_source' 'BUILD' "$out"
check_grep 'apply restarts the service' 'SVC restart' "$out"
check_grep 'apply records the build stage for the webapp banner (issue #89)' '"stage":"building"' "$(cat "$PD_HOME/var/build-stage.snapshot")"
check_grep 'apply records the restart stage' '"stage":"restarting"' "$(cat "$PD_HOME/var/restart-stage.snapshot")"
check_grep 'apply ends with done progress (issue #89)' '"stage":"done"' "$(cat "$PD_HOME/var/update-state.json")"

# --- apply path: build failure records failed progress (issue #89) ----------
# A failed rebuild must never leave the webapp banner waiting on a phantom
# stage: the shim's EXIT trap records `failed` for /api/update to serve.
cat > "$PD_HOME/lib/source.sh" <<'EOF'
resolve_source() { :; }
build_from_source() { die 'build failed'; }
EOF
out=$(run_shim "$LOCAL_SHA" "$REMOTE_NEW" update 2>&1); rc=$?
check_eq 'apply with a failing build exits nonzero' '1' "$rc"
check_grep 'failing build records failed progress (issue #89)' '"stage":"failed"' "$(cat "$PD_HOME/var/update-state.json")"
cp "$INSTALL_DIR/lib/source.sh" "$PD_HOME/lib/"

# --- apply path: installed shell layer refresh (issue #66) -------------------
# Regression: `pideck update` used to refresh $PD_HOME/src, rebuild and
# restart — but never re-copied the installed shell layer ($PD_LIB/*.sh,
# onboard.sh, bin/*) or the rendered service units, so fixes to the install
# scripts themselves never reached machines that update via the CLI.
#
# Setup: a fake freshly-fetched source tree whose shell files differ from the
# installed ones; resolve_source is stubbed to point PD_SRC at it (as the real
# one does after fetch+reset). The fresh tree carries the real current lib/bin
# scripts; the installed layer carries the same files plus a marker line —
# functional (the shim sources the installed copies) but distinguishable.
# After update_apply the installed files must match the source, the
# ~/.local/bin/pideck symlink must survive, and the service units must
# have been re-registered.
FAKE_SRC="$tmp/fresh-src"
mkdir -p "$FAKE_SRC/install/bin" "$FAKE_SRC/install/lib" "$FAKE_SRC/install/service"
cp "$INSTALL_DIR/lib/"*.sh "$FAKE_SRC/install/lib/"
cp "$INSTALL_DIR/onboard.sh" "$FAKE_SRC/install/onboard.sh"
cp "$INSTALL_DIR/bin/pideck" "$INSTALL_DIR/bin/pideck-daemon" "$FAKE_SRC/install/bin/"
printf 'unit template v2\n' > "$FAKE_SRC/install/service/pideck-daemon.service"

# stale installed layer: real scripts + marker line (so they differ from the
# fresh tree but keep the shim runnable)
for _stale_lib in "$FAKE_SRC/install/lib/"*.sh; do
  _stale_name=$(basename "$_stale_lib")
  cp "$_stale_lib" "$PD_HOME/lib/$_stale_name"
  printf '# stale installed copy\n' >> "$PD_HOME/lib/$_stale_name"
done
printf '# stale installed copy\n' >> "$PD_HOME/lib/onboard.sh"
printf '#!/bin/sh\n# stale shim\n' > "$PD_HOME/bin/pideck"
printf '#!/bin/sh\n# stale launcher\n' > "$PD_HOME/bin/pideck-daemon"
# pre-rebrand leftovers (issue #125): the refresh + compat pass must replace
# these real old-name files with symlinks to the renamed binaries
printf '#!/bin/sh\n# pre-rebrand shim\n' > "$PD_HOME/bin/agentskiss"
printf '#!/bin/sh\n# pre-rebrand launcher\n' > "$PD_HOME/bin/agentskiss-daemon"
rm -rf "$PD_HOME/.local" # no leftover symlink from an earlier pass

# The shim sources the installed copies of service.sh/update.sh — put the
# test stubs back over the stale copies, and stub source.sh: "fetch" = point
# PD_SRC at the fresh tree (the real resolve_source ends with PD_SRC at the
# reset checkout); build is a no-op marker.
cat > "$PD_HOME/lib/service.sh" <<'EOF'
svc_restart() { printf 'SVC restart\n'; }
register_service() { printf 'REGISTER service\n'; }
EOF
cat > "$PD_HOME/lib/source.sh" <<EOF
resolve_source() { PD_SRC="$FAKE_SRC"; printf 'RESOLVE fetch %s\n' "\$PD_REPO_REF"; }
build_from_source() { printf 'BUILD\n'; }
EOF

out=$(run_shim "$LOCAL_SHA" "$REMOTE_NEW" update); rc=$?
check_eq 'apply with refresh exits 0' '0' "$rc"
check_grep 'refresh still runs after fetch + build' 'RESOLVE fetch dev-branch' "$out"
check_grep 'refresh re-registers the service units' 'REGISTER service' "$out"
check_grep 'refresh restarts the service' 'SVC restart' "$out"

for _fresh_lib in "$FAKE_SRC/install/lib/"*.sh; do
  _stale_name=$(basename "$_fresh_lib")
  if cmp -s "$_fresh_lib" "$PD_HOME/lib/$_stale_name"; then
    printf 'ok - installed lib/%s refreshed\n' "$_stale_name"
  else
    printf 'not ok - installed lib/%s was not refreshed from the fetched source\n' "$_stale_name"
    failures=$((failures + 1))
  fi
done
if cmp -s "$FAKE_SRC/install/onboard.sh" "$PD_HOME/lib/onboard.sh"; then
  printf 'ok - installed onboard.sh refreshed\n'
else
  printf 'not ok - installed onboard.sh was not refreshed from the fetched source\n'
  failures=$((failures + 1))
fi
for _fresh_bin in "$FAKE_SRC/install/bin/"*; do
  _stale_name=$(basename "$_fresh_bin")
  if cmp -s "$_fresh_bin" "$PD_HOME/bin/$_stale_name" && [ -x "$PD_HOME/bin/$_stale_name" ]; then
    printf 'ok - installed bin/%s refreshed (executable)\n' "$_stale_name"
  else
    printf 'not ok - installed bin/%s not refreshed/executable\n' "$_stale_name"
    failures=$((failures + 1))
  fi
done
if [ "$(readlink "$PD_HOME/.local/bin/pideck")" = "$PD_HOME/bin/pideck" ]; then
  printf 'ok - ~/.local/bin/pideck symlink preserved\n'
else
  printf 'not ok - ~/.local/bin/pideck symlink missing/wrong after refresh\n'
  failures=$((failures + 1))
fi
# pre-rebrand name compat (issue #125): old names must resolve to the new
# binaries after a refresh, in the home bin dir and in ~/.local/bin
if [ "$(readlink "$PD_HOME/bin/agentskiss")" = "pideck" ] &&
  [ "$(readlink "$PD_HOME/bin/agentskiss-daemon")" = "pideck-daemon" ]; then
  printf 'ok - in-home pre-rebrand bin compat symlinks created\n'
else
  printf 'not ok - in-home pre-rebrand bin compat symlinks missing/wrong after refresh\n'
  failures=$((failures + 1))
fi
if [ "$(readlink "$PD_HOME/.local/bin/agentskiss")" = "$PD_HOME/bin/pideck" ]; then
  printf 'ok - ~/.local/bin/agentskiss compat symlink created\n'
else
  printf 'not ok - ~/.local/bin/agentskiss compat symlink missing/wrong after refresh\n'
  failures=$((failures + 1))
fi
cp "$INSTALL_DIR/lib/source.sh" "$PD_HOME/lib/"

# --- summary ----------------------------------------------------------------
if [ "$failures" -eq 0 ]; then
  printf '# all update tests passed\n'
  exit 0
fi
printf '# %s update test(s) failed\n' "$failures"
exit 1
