#!/bin/sh
# shellcheck shell=sh disable=SC2154 # failures comes from the sourced harness
# Plain-shell tests for the install/bin/pideck shim. Covers: shim-owned
# service verbs, daemon CLI forwarding with args intact and exit codes
# propagated, the shim verbs that must NOT be forwarded, and the
# missing-build error path.
set -u

# shellcheck disable=SC1091 # shared test harness, sourced on purpose
. "$(dirname -- "$0")/harness.sh"

# --- fake install layout ---------------------------------------------------
PD_HOME="$tmp/home"
PD_SRC="$tmp/src"
mkdir -p "$PD_HOME/lib" "$PD_HOME/log" "$PD_SRC/apps/daemon/dist"

cat > "$PD_HOME/env" <<EOF
PD_HOME="$PD_HOME"
PD_SRC="$PD_SRC"
PD_NODE="$tmp/fake-node"
PD_WEB_PORT="8321"
EOF

# Stub libs: record service calls instead of touching a real system.
cat > "$PD_HOME/lib/common.sh" <<'EOF'
detect_os() { :; }
EOF
cp "$SCRIPT_DIR/service-stub.sh" "$PD_HOME/lib/service.sh"

# fake-node: emulate `node <script> args...` by running the script with sh.
cat > "$tmp/fake-node" <<'EOF'
#!/bin/sh
script=$1
[ -f "$script" ] || { printf 'fake-node: %s: not found\n' "$script" >&2; exit 127; }
shift
exec /bin/sh "$script" "$@"
EOF
chmod +x "$tmp/fake-node"

# Stand-in daemon CLI: echo the argv, echo the daemon URL it would use, exit
# with $FAKE_EXIT so exit-code propagation is observable.
cat > "$PD_SRC/apps/daemon/dist/cli.js" <<'EOF'
printf 'DAEMON-CLI: %s\n' "$*"
printf 'DAEMON-URL: %s\n' "${PD_DAEMON_URL:-unset}"
exit "${FAKE_EXIT:-0}"
EOF

# --- tiny harness: see test/harness.sh (check_eq / check_grep) --------------

run_shim() { env PD_HOME="$PD_HOME" sh "$SHIM" "$@"; }

# --- shim-owned service-control verbs ---------------------------------------
check_eq 'service start stays on the shim' 'SVC start' "$(run_shim service start)"
check_eq 'service stop stays on the shim' 'SVC stop' "$(run_shim service stop)"
check_eq 'service restart stays on the shim' 'SVC restart' "$(run_shim service restart)"

out=$(run_shim service status)
check_grep 'service status runs svc_status' 'SVC status' "$out"
check_grep 'service status prints webapp URL' 'webapp: http://127.0.0.1:8321' "$out"

out=$(run_shim service bogus 2>&1); rc=$?
check_grep 'unknown service verb errors' 'unknown service command: bogus' "$out"
check_eq 'unknown service verb exits 1' '1' "$rc"

out=$(run_shim addr)
check_grep 'addr prints the webapp URL' 'http://127.0.0.1:8321' "$out"
check_no_grep 'addr does not reach the daemon CLI' 'DAEMON-CLI' "$out"

out=$(run_shim help)
check_grep 'help documents service control' 'service start|stop|restart|status' "$out"
check_grep 'help documents forwarding' 'forwarded to the daemon CLI' "$out"

# --- daemon CLI forwarding (SPEC CLI verbs) ---------------------------------
out=$(run_shim status)
check_grep 'status forwards to the daemon CLI' 'DAEMON-CLI: status' "$out"
check_no_grep 'status does not run svc_status' 'SVC status' "$out"

out=$(run_shim project ls)
check_grep 'project ls forwards' 'DAEMON-CLI: project ls' "$out"

out=$(run_shim project get abc)
check_grep 'project get forwards' 'DAEMON-CLI: project get abc' "$out"

out=$(run_shim sessions)
check_grep 'sessions forwards' 'DAEMON-CLI: sessions' "$out"

out=$(run_shim workers)
check_grep 'workers forwards' 'DAEMON-CLI: workers' "$out"

out=$(run_shim send --session s1 --message "hello world")
check_grep 'send forwards with args intact' 'DAEMON-CLI: send --session s1 --message hello world' "$out"

FAKE_EXIT=7 run_shim send --session s1 --message hi >/dev/null 2>&1
check_eq 'daemon CLI exit code propagates' '7' "$?"

out=$(run_shim whatever --flag value)
check_grep 'unknown-to-shim command forwards' 'DAEMON-CLI: whatever --flag value' "$out"

check_grep 'daemon URL defaults to loopback port from env' 'DAEMON-URL: http://127.0.0.1:8321' "$(run_shim status)"
check_grep 'caller-provided daemon URL wins' 'DAEMON-URL: http://localhost:9999' \
  "$(env PD_DAEMON_URL=http://localhost:9999 PD_HOME="$PD_HOME" sh "$SHIM" status)"

# --- shim verbs that must NOT be forwarded ----------------------------------
: > "$PD_HOME/log/daemon.out.log"; : > "$PD_HOME/log/daemon.err.log"
out=$(run_shim logs 2>/dev/null); rc=$?
check_eq 'logs stays on the shim' '0' "$rc"
check_no_grep 'logs does not reach the daemon CLI' 'DAEMON-CLI' "$out"

# --- missing daemon build ---------------------------------------------------
mv "$PD_SRC/apps/daemon/dist/cli.js" "$PD_SRC/apps/daemon/dist/cli.js.bak"
out=$(run_shim status 2>&1); rc=$?
check_grep 'missing build errors clearly' 'daemon CLI missing' "$out"
check_eq 'missing build exits nonzero' '1' "$rc"
mv "$PD_SRC/apps/daemon/dist/cli.js.bak" "$PD_SRC/apps/daemon/dist/cli.js"

# --- summary ----------------------------------------------------------------
if [ "$failures" -eq 0 ]; then
  printf '# all shim-routing tests passed\n'
  exit 0
fi
printf '# %s test(s) failed\n' "$failures" >&2
exit 1
