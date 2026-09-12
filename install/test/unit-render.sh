#!/bin/sh
# shellcheck shell=sh disable=SC2154,SC2034 # SC2154: failures comes from the sourced harness; SC2034: env vars are consumed by the sourced lib/service.sh
# Plain-shell tests for the service unit rendering (lib/service.sh
# _render_file + the templates in install/service/). Asserts that both units
# render with every placeholder substituted and keep the properties the spec
# requires: restart on crash, start at login, env sourced via the
# pideck-daemon launcher. No launchd/systemd touched.
set -u

# shellcheck disable=SC1091 # shared test harness, sourced on purpose
. "$(dirname -- "$0")/harness.sh"

PD_HOME="$tmp/home"
PD_SRC="$tmp/src"
PD_DRY_RUN=0
PD_WEB_PORT=8321
PD_LOCAL_BIN="$HOME/.local/bin"
PD_NODE_BIN="$tmp/opt/node/bin/node"
PD_NODE_BIN_DIR="$tmp/opt/node/bin"
export PD_HOME PD_SRC PD_WEB_PORT

# shellcheck disable=SC1091 # installer libs, sourced on purpose
. "$INSTALL_DIR/lib/common.sh"
# shellcheck disable=SC1091 # installer lib, sourced on purpose
. "$INSTALL_DIR/lib/service.sh"

DETECTED_OS=linux

# --- systemd user unit ------------------------------------------------------
out=$(_render_file "$INSTALL_DIR/service/pideck-daemon.service" "$tmp/pideck-daemon.service"; cat "$tmp/pideck-daemon.service")
check_eq 'systemd render exits cleanly' '0' "$?"
check_grep 'systemd unit runs the daemon launcher' "ExecStart=$PD_HOME/bin/pideck-daemon" "$out"
check_grep 'systemd unit restarts on crash' 'Restart=on-failure' "$out"
check_grep 'systemd unit keeps restarting after repeated crashes' 'StartLimitIntervalSec=0' "$out"
check_grep 'systemd unit starts at login' 'WantedBy=default.target' "$out"
check_grep 'systemd unit works from the source checkout' "WorkingDirectory=$PD_SRC" "$out"
check_grep 'systemd unit exports the install home' "Environment=PD_HOME=$PD_HOME" "$out"
check_grep 'systemd unit exports the webapp port' "Environment=PD_WEB_PORT=8321" "$out"

_no_placeholders() { # _no_placeholders <name> <file> — no @PD_X@ outside doc comments
  if grep -Eq '@PD_[A-Z_]+@' "$2"; then
    printf 'not ok - %s: rendered file still contains placeholders\n' "$1"
    failures=$((failures + 1))
  else
    printf 'ok - %s\n' "$1"
  fi
}
_no_placeholders 'systemd unit has no leftover placeholders' "$tmp/pideck-daemon.service"

# --- launchd agent ----------------------------------------------------------
out=$(_render_file "$INSTALL_DIR/service/com.pideck.daemon.plist" "$tmp/com.pideck.daemon.plist"; cat "$tmp/com.pideck.daemon.plist")
check_eq 'launchd render exits cleanly' '0' "$?"
check_grep 'launchd plist runs the daemon launcher' "$PD_HOME/bin/pideck-daemon" "$out"
check_grep 'launchd plist starts at login' '<key>RunAtLoad</key>' "$out"
check_grep 'launchd plist restarts on crash' '<key>KeepAlive</key>' "$out"
check_grep 'launchd plist keepalive covers nonzero exits' '<key>SuccessfulExit</key>' "$out"
check_grep 'launchd plist captures stdout' "$PD_HOME/log/daemon.out.log" "$out"
check_grep 'launchd plist captures stderr' "$PD_HOME/log/daemon.err.log" "$out"
_no_placeholders 'launchd plist has no leftover placeholders' "$tmp/com.pideck.daemon.plist"

# --- both units exec the launcher that sources ~/.pideck/env ----------------
launcher="$INSTALL_DIR/bin/pideck-daemon"
_launcher_body=$(cat "$launcher")
# shellcheck disable=SC2016 # grep pattern is single-quoted ON PURPOSE
check_grep 'launcher sources the env file' '. "$PD_ENV"' "$_launcher_body"
check_grep 'launcher execs the daemon entrypoint' 'apps/daemon/dist/index.js' "$_launcher_body"

# --- dry-run rendering prints a marker instead of touching disk -------------
PD_DRY_RUN=1
out=$(_render_file "$INSTALL_DIR/service/pideck-daemon.service" "$tmp/dry-run.service" 2>&1)
check_grep 'dry-run render prints a marker' '[dry-run] render' "$out"
check_eq 'dry-run render writes no file' '' "$(cat "$tmp/dry-run.service" 2>/dev/null || :)"
PD_DRY_RUN=0

# --- missing template dies --------------------------------------------------
out=$(_render_file "$tmp/does-not-exist.tpl" "$tmp/nope.out" 2>&1); rc=$?
check_grep 'missing template errors clearly' 'service template missing' "$out"
check_eq 'missing template exits nonzero' '1' "$rc"

# --- summary ----------------------------------------------------------------
if [ "$failures" -eq 0 ]; then
  printf '# all unit-render tests passed\n'
  exit 0
fi
printf '# %s test(s) failed\n' "$failures" >&2
exit 1
