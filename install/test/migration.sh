#!/bin/sh
# shellcheck shell=sh disable=SC2016,SC2154 # SC2016: snippets expand in the sourced sub-shell; SC2154: failures comes from harness.sh
# Rebrand migration tests (issue #125): migrate_home() + install_bin_compat()
# from lib/common.sh, and bin/pideck's inline pre-lib migration. Fixtures are
# fake install layouts in a temp tree; nothing touches launchd/systemd.
set -u

# shellcheck disable=SC1091 # shared test harness, sourced on purpose
. "$(dirname -- "$0")/harness.sh"

# Sources common.sh with the fake home pinned (like run_update in
# test/update.sh) and evaluates a snippet. HOME is pinned so ~/.agentskiss
# and ~/.local/bin writes land in the tmp tree.
run_common() { # run_common <dry-run> <home> <snippet>
  env PD_DRY_RUN="$1" SNIPPET="$3" \
    HOME="$2" \
    sh -c '
      set -u
      PD_HOME="$HOME/.pideck"
      export PD_HOME
      . "'"$INSTALL_DIR"'/lib/common.sh"
      eval "$SNIPPET"
  '
}

# Make a minimal pre-rebrand install home (as an old agentskiss install had
# it: AGENTSKISS_* env names pointing at the old home, old-name bin shims).
make_old_home() { # make_old_home <dir>
  mkdir -p "$1/bin" "$1/lib" "$1/log" "$1/state" "$1/src"
  cat > "$1/env" <<EOF
AGENTSKISS_HOME="$1"
AGENTSKISS_SRC="$1/src"
AGENTSKISS_NODE="$1/opt/node/bin/node"
AGENTSKISS_WEB_PORT="8321"
AGENTSKISS_WEB_HOST="0.0.0.0"
AGENTSKISS_MODEL="anthropic/claude-x"
EOF
  printf '#!/bin/sh\n# pre-rebrand shim\n' > "$1/bin/agentskiss"
  printf '#!/bin/sh\n# pre-rebrand launcher\n' > "$1/bin/agentskiss-daemon"
  printf '{\n  "installedAt": "2026-01-01T00:00:00Z"\n}\n' > "$1/config.json"
  printf '{}\n' > "$1/onboarding.json"
}

# --- migrate_home: fresh install (no old home) → no-op ----------------------
mkdir -p "$tmp/home-run/.pideck"
out=$(run_common 0 "$tmp/home-run" 'migrate_home; printf "exists:%s symlink:%s" "$([ -e "$HOME/.agentskiss" ] && echo y)" "$([ -L "$HOME/.agentskiss" ] && echo y)"')
check_eq 'fresh install: no old home created, no migration' 'exists: symlink:' "$out"
rmdir "$tmp/home-run/.pideck"

# --- migrate_home: old home present → move + compat symlink + env rewrite ---
make_old_home "$tmp/home-run/.agentskiss"
out=$(run_common 0 "$tmp/home-run" 'migrate_home')
check_grep 'migration moves the home' 'migrated install home' "$out"
check_grep 'migration keeps a compat symlink' 'compat symlink kept' "$out"
check_eq 'old home is now a symlink to the new home' "$tmp/home-run/.pideck" "$(readlink "$tmp/home-run/.agentskiss")"
for _entry in env config.json onboarding.json bin lib log state; do
  [ -e "$tmp/home-run/.pideck/$_entry" ] || {
    printf 'not ok - migration preserved %s\n' "$_entry"
    failures=$((failures + 1))
  }
done
printf 'ok - migration preserved env/config.json/onboarding.json/bin/lib/log/state\n'
check_grep 'migration rewrites MODEL to PIDECK_MODEL' 'PIDECK_MODEL="anthropic/claude-x"' "$(cat "$tmp/home-run/.pideck/env")"
check_grep 'migration rewrites the rest to PD_*' 'PD_WEB_PORT="8321"' "$(cat "$tmp/home-run/.pideck/env")"
check_no_agentkiss_env() {
  case "$(cat "$tmp/home-run/.pideck/env")" in
    *AGENTSKISS_*)
      printf 'not ok - migration left AGENTSKISS_* names in env\n'
      failures=$((failures + 1))
      ;;
    *) printf 'ok - no AGENTSKISS_* names left in env\n' ;;
  esac
}
check_no_agentkiss_env
check_grep 'migration points recorded paths at the new home' "PD_HOME=\"$tmp/home-run/.pideck\"" "$(cat "$tmp/home-run/.pideck/env")"
case "$(cat "$tmp/home-run/.pideck/config.json")" in
  *".agentskiss"*)
    printf 'not ok - migration left old-home paths in config.json\n'
    failures=$((failures + 1))
    ;;
  *) printf 'ok - config.json path values point at the new home\n' ;;
esac
check_grep 'old paths still resolve through the compat symlink' '8321' "$(cat "$tmp/home-run/.agentskiss/env")"

# --- migrate_home: idempotent (old home is the compat symlink) ---------------
out=$(run_common 0 "$tmp/home-run" 'migrate_home; printf "moved-again"')
check_eq 'already migrated: no second migration output' 'moved-again' "$out"

# --- migrate_home: both homes exist → warn, keep new, no move ---------------
mkdir -p "$tmp/home-run2"
make_old_home "$tmp/home-run2/.agentskiss"
make_old_home "$tmp/home-run2/.pideck"
out=$(env PD_DRY_RUN=0 SNIPPET='migrate_home' HOME="$tmp/home-run2" \
  sh -c 'set -u; PD_HOME="$HOME/.pideck"; export PD_HOME; . "'"$INSTALL_DIR"'/lib/common.sh"; eval "$SNIPPET"' 2>&1)
check_grep 'both homes: warns and refuses to merge' 'both' "$out"
check_eq 'both homes: old home untouched (no symlink)' '' "$(readlink "$tmp/home-run2/.agentskiss" 2>/dev/null || printf '')"

# --- migrate_home: dry-run prints without mutating ---------------------------
mkdir -p "$tmp/home-run3"
make_old_home "$tmp/home-run3/.agentskiss"
out=$(run_common 1 "$tmp/home-run3" 'migrate_home')
check_grep 'dry-run prints the move' '[dry-run] mv' "$out"
check_eq 'dry-run does not move the home' 'y' "$([ -d "$tmp/home-run3/.agentskiss" ] && echo y)"
check_eq 'dry-run creates no compat symlink' '' "$(readlink "$tmp/home-run3/.agentskiss" 2>/dev/null || printf '')"

# --- install_bin_compat: old-name files replaced by symlinks -----------------
mkdir -p "$tmp/home-run4/.pideck/bin" "$tmp/home-run4/.pideck/lib" "$tmp/home-run4/.local"
printf '#!/bin/sh\n# new shim\n' > "$tmp/home-run4/.pideck/bin/pideck"
printf '#!/bin/sh\n# new launcher\n' > "$tmp/home-run4/.pideck/bin/pideck-daemon"
printf '#!/bin/sh\n# pre-rebrand shim\n' > "$tmp/home-run4/.pideck/bin/agentskiss"
out=$(env PD_DRY_RUN=0 SNIPPET='install_bin_compat' HOME="$tmp/home-run4" \
  sh -c 'set -u; PD_HOME="$HOME/.pideck"; export PD_HOME; . "'"$INSTALL_DIR"'/lib/common.sh"; eval "$SNIPPET"' 2>&1)
check_eq 'compat: in-home agentskiss → pideck' 'pideck' "$(readlink "$tmp/home-run4/.pideck/bin/agentskiss")"
check_eq 'compat: in-home agentskiss-daemon → pideck-daemon' 'pideck-daemon' "$(readlink "$tmp/home-run4/.pideck/bin/agentskiss-daemon")"
check_eq 'compat: ~/.local/bin/agentskiss → pideck' "$tmp/home-run4/.pideck/bin/pideck" "$(readlink "$tmp/home-run4/.local/bin/agentskiss")"

# --- shim: inline home migration on a pre-rebrand install --------------------
# The shim must migrate ~/.agentskiss → ~/.pideck itself (before it could
# source any lib), then run normally. Fake libs keep the shim self-contained
# (they live in the old home's lib/, exactly like a real pre-rebrand install).
make_old_home "$tmp/shim-home/.agentskiss"
cp "$SCRIPT_DIR/service-stub.sh" "$tmp/shim-home/.agentskiss/lib/service.sh"
cat > "$tmp/shim-home/.agentskiss/lib/common.sh" <<'EOF'
detect_os() { :; }
EOF
: > "$tmp/shim-home/.agentskiss/log/daemon.out.log"; : > "$tmp/shim-home/.agentskiss/log/daemon.err.log"
out=$(env HOME="$tmp/shim-home" sh "$SHIM" help 2>&1); rc=$?
check_eq 'shim on pre-rebrand install exits 0' '0' "$rc"
check_grep 'shim migrates the home' 'migrated install home' "$out"
check_eq 'shim migration leaves compat symlink' "$tmp/shim-home/.pideck" "$(readlink "$tmp/shim-home/.agentskiss")"
check_grep 'shim works after migration (help)' 'service start|stop|restart|status' "$out"
check_grep 'shim migration rewrote MODEL (PIDECK_MODEL)' 'PIDECK_MODEL="anthropic/claude-x"' "$(cat "$tmp/shim-home/.pideck/env")"
check_grep 'shim migration points env paths at the new home' "PD_HOME=\"$tmp/shim-home/.pideck\"" "$(cat "$tmp/shim-home/.pideck/env")"
# idempotent: second invocation must not re-migrate or fail
out=$(env HOME="$tmp/shim-home" sh "$SHIM" help 2>&1); rc=$?
check_eq 'shim second run exits 0 (idempotent)' '0' "$rc"
case "$out" in
  *'migrated install home'*)
    printf 'not ok - shim re-migrated an already-migrated home\n'
    failures=$((failures + 1))
    ;;
  *) printf 'ok - shim second run does not re-migrate\n' ;;
esac

# --- shim: no migration when only the new home exists ------------------------
mkdir -p "$tmp/shim-home2/.pideck/lib" "$tmp/shim-home2/.pideck/log"
cat > "$tmp/shim-home2/.pideck/lib/common.sh" <<'EOF'
detect_os() { :; }
EOF
cp "$tmp/shim-home/.pideck/lib/service.sh" "$tmp/shim-home2/.pideck/lib/service.sh"
cat > "$tmp/shim-home2/.pideck/env" <<EOF
PD_HOME="$tmp/shim-home2/.pideck"
PD_SRC="$tmp/shim-home2/.pideck/src"
PD_WEB_PORT="8321"
EOF
: > "$tmp/shim-home2/.pideck/log/daemon.out.log"; : > "$tmp/shim-home2/.pideck/log/daemon.err.log"
out=$(env HOME="$tmp/shim-home2" sh "$SHIM" help 2>&1); rc=$?
check_eq 'shim on already-renamed install exits 0' '0' "$rc"
case "$out" in
  *'migrated install home'*)
    printf 'not ok - shim migrated when only the new home exists\n'
    failures=$((failures + 1))
    ;;
  *) printf 'ok - shim does not migrate a fresh/new-layout home\n' ;;
esac

# --- summary -----------------------------------------------------------------
if [ "$failures" -eq 0 ]; then
  printf '# all migration tests passed\n'
  exit 0
fi
printf '# %s migration test(s) failed\n' "$failures" >&2
exit 1
