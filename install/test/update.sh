#!/bin/sh
# Plain-shell tests for the self-update flow (issue #55): the check logic in
# install/lib/update.sh with fake git/gh on PATH, plus the install/bin/agentskiss
# shim wiring for `update --check` and the apply path's reuse of the installer
# machinery (resolve_source/build_from_source + svc_restart). No network, no
# real git/gh, no real service.
#
# SC2016: the run_update snippets are single-quoted ON PURPOSE — they must
# expand inside the test shell that sources update.sh, not here.
# shellcheck shell=sh disable=SC2016
set -u

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTALL_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
SHIM="$INSTALL_DIR/bin/agentskiss"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

failures=0

check_eq() { # check_eq <name> <expected> <actual>
  if [ "$2" = "$3" ]; then
    printf 'ok - %s\n' "$1"
  else
    printf 'not ok - %s\n     expected: %s\n     actual:   %s\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

check_grep() { # check_grep <name> <needle> <haystack>
  case "$3" in
    *"$2"*) printf 'ok - %s\n' "$1" ;;
    *)
      printf 'not ok - %s: output missing [%s]\n     actual: [%s]\n' "$1" "$2" "$3"
      failures=$((failures + 1))
      ;;
  esac
}

check_no_grep() { # check_no_grep <name> <needle> <haystack>
  case "$3" in
    *"$2"*)
      printf 'not ok - %s: output unexpectedly contains [%s]\n     actual: [%s]\n' "$1" "$2" "$3"
      failures=$((failures + 1))
      ;;
    *) printf 'ok - %s\n' "$1" ;;
  esac
}

LOCAL_SHA="1111111111111111111111111111111111111111"
REMOTE_SAME="$LOCAL_SHA"
REMOTE_NEW="2222222222222222222222222222222222222222"

# --- install layout under test ---------------------------------------------
AK_HOME="$tmp/home"
AK_SRC="$AK_HOME/src"
mkdir -p "$AK_HOME/lib" "$AK_HOME/bin" "$AK_SRC/.git"
cp "$INSTALL_DIR/lib/common.sh" "$INSTALL_DIR/lib/source.sh" "$INSTALL_DIR/lib/update.sh" "$AK_HOME/lib/"
cat > "$AK_HOME/lib/service.sh" <<'EOF'
svc_restart() { printf 'SVC restart\n'; }
EOF

# env file (as bootstrap writes it) + config.json pointing at a private repo/ref
cat > "$AK_HOME/env" <<EOF
AGENTSKISS_HOME="$AK_HOME"
AGENTSKISS_SRC="$AK_SRC"
AGENTSKISS_NODE="$tmp/fake-node"
AGENTSKISS_WEB_PORT="8321"
AGENTSKISS_WEB_HOST="0.0.0.0"
EOF
write_config() {
  cat > "$AK_HOME/config.json" <<'EOF'
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
run_update() {
  env PATH="$FAKE_BIN:$PATH" \
    FAKE_LOCAL_SHA="$1" FAKE_REMOTE_SHA="$2" FAKE_REMOTE_URL="$3" UPDATE_SNIPPET="$4" \
    AGENTSKISS_HOME="$AK_HOME" \
    sh -c '
      set -u
      set -a; . "$AGENTSKISS_HOME/env"; set +a
      . "$AGENTSKISS_HOME/lib/common.sh"
      detect_os
      . "$AGENTSKISS_HOME/lib/update.sh"
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
check_grep 'update available suggests the apply command' 'agentskiss update' "$out"

out=$(run_update "$LOCAL_SHA" "" "" 'update_check; update_report' 2>&1); rc=$?
check_eq 'gh failure exits nonzero' '1' "$rc"
check_grep 'gh failure explains auth' 'gh auth status' "$out"

out=$(run_update "" "$REMOTE_NEW" "" 'update_check; update_report' 2>&1); rc=$?
check_eq 'missing local source exits nonzero' '1' "$rc"
check_grep 'missing local source explained' 'no local source revision' "$out"

out=$(run_update "$LOCAL_SHA" "$REMOTE_NEW" "" 'update_check; printf "%s" "$UPDATE_REPO:$UPDATE_REF"')
check_eq 'repo/ref resolved from the installer config' 'acme/private-dev:dev-branch' "$out"

# no config.json → git remote fallback (ssh URL), ref defaults to main
rm -f "$AK_HOME/config.json"
out=$(run_update "$LOCAL_SHA" "$REMOTE_NEW" "git@github.com:dev/fork.git" 'update_check; printf "%s" "$UPDATE_REPO:$UPDATE_REF"')
check_eq 'git remote fallback yields ssh slug + main ref' 'dev/fork:main' "$out"
write_config

# --- shim wiring ------------------------------------------------------------

run_shim() { # run_shim <local-sha> <remote-sha|''> <args...>
  _rs_local=$1; _rs_remote=$2; shift 2
  env PATH="$FAKE_BIN:$PATH" FAKE_LOCAL_SHA="$_rs_local" FAKE_REMOTE_SHA="$_rs_remote" \
    AGENTSKISS_HOME="$AK_HOME" sh "$SHIM" "$@"
}

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update --check)
check_grep 'shim update --check reports up to date' 'up to date' "$out"
check_no_grep 'shim update --check is not forwarded to the daemon CLI' 'DAEMON-CLI' "$out"

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" help)
check_grep 'help documents the update verb' 'update [--check]' "$out"

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update bogus 2>&1); rc=$?
check_eq 'unknown update command exits 1' '1' "$rc"
check_grep 'unknown update command usage error' 'usage: agentskiss update' "$out"

# --- apply path (up to date → no rebuild, no restart) -----------------------

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update); rc=$?
check_eq 'apply when up to date exits 0' '0' "$rc"
check_no_grep 'apply when up to date does not restart the service' 'SVC restart' "$out"
check_grep 'apply when up to date says so' 'up to date' "$out"

# --- apply path (update available → fetch, build, restart) ------------------
# Stub the installer machinery here: the real resolve_source/build_from_source
# need network + pnpm; the flow under test is *that they are reused*, in
# order, with the configured ref, and that svc_restart runs after them.
cat > "$AK_HOME/lib/source.sh" <<'EOF'
resolve_source() { printf 'RESOLVE fetch %s\n' "$AK_REPO_REF"; }
build_from_source() { printf 'BUILD\n'; }
EOF
out=$(run_shim "$LOCAL_SHA" "$REMOTE_NEW" update); rc=$?
check_eq 'apply with update available exits 0' '0' "$rc"
check_grep 'apply fetches the configured ref' 'RESOLVE fetch dev-branch' "$out"
check_grep 'apply rebuilds via build_from_source' 'BUILD' "$out"
check_grep 'apply restarts the service' 'SVC restart' "$out"
cp "$INSTALL_DIR/lib/source.sh" "$AK_HOME/lib/"

# --- summary ----------------------------------------------------------------
if [ "$failures" -eq 0 ]; then
  printf '# all update tests passed\n'
  exit 0
fi
printf '# %s update test(s) failed\n' "$failures"
exit 1
