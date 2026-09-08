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
# The running-build SHA the #198/#223 restart-only scenarios publish.
STALE_RUNNING="3333333333333333333333333333333333333333"

# --- install layout under test ---------------------------------------------
PD_HOME="$tmp/home"
PD_SRC="$PD_HOME/src"
mkdir -p "$PD_HOME/lib" "$PD_HOME/bin" "$PD_HOME/.local/bin" "$PD_SRC/.git"
cp "$INSTALL_DIR/lib/common.sh" "$INSTALL_DIR/lib/source.sh" "$INSTALL_DIR/lib/update.sh" "$INSTALL_DIR/lib/assets.sh" "$PD_HOME/lib/"
cat > "$PD_HOME/lib/service.sh" <<'EOF'
# register_service dereferences PD_NODE_BIN/PD_NODE_BIN_DIR like the real
# _render_file templates do — a regression guard for issue #208 (the shim
# must derive them; a plain shell has no service-env variables).
svc_restart() { printf 'SVC restart\n'; cp "$PD_HOME/var/update-state.json" "$PD_HOME/var/restart-stage.snapshot" 2>/dev/null; }
register_service() { printf 'REGISTER service node=%s dir=%s\n' "${PD_NODE_BIN:?PD_NODE_BIN: parameter not set — shim must derive it (issue #208)}" "${PD_NODE_BIN_DIR:?PD_NODE_BIN_DIR: parameter not set (issue #208)}"; }
EOF

# --- fake private node + npm (issue #202) -----------------------------------
# Applies that reach the installing stage refresh the private node and
# reinstall pi under it; both must be stubbed so no test touches the network.
# The env file points PD_NODE at a fake old node (v22.14.0, under $PD_HOME/opt
# like the real thing) so the first installing apply exercises the refresh; a
# stub deps.sh "installs" a fake new node (v22.23.2); a stub npm records the
# pi install and drops a fake pi into the private npm prefix; set_pd_node
# rewrites the env file the way refresh_node_runtime does.
ORDER_LOG="$tmp/order.log"
OLD_NODE_DIR="$PD_HOME/opt/node-v22.14.0-linux-x64/bin"
NEW_NODE_DIR="$PD_HOME/opt/node-v22.23.2-linux-x64/bin"
mkdir -p "$OLD_NODE_DIR" "$NEW_NODE_DIR"
printf '#!/bin/sh\n[ "$1" = -v ] && printf "v22.14.0\\n"\n' > "$OLD_NODE_DIR/node"
printf '#!/bin/sh\n[ "$1" = -v ] && printf "v22.23.2\\n"\n' > "$NEW_NODE_DIR/node"
chmod +x "$OLD_NODE_DIR/node" "$NEW_NODE_DIR/node"
PI_SHIM_SRC="$tmp/pi-shim"
printf '#!/bin/sh\nprintf "1.0.0\\n"\n' > "$PI_SHIM_SRC"
chmod +x "$PI_SHIM_SRC"
cat > "$NEW_NODE_DIR/npm" <<'EOF'
#!/bin/sh
case "$1" in
  view) printf '%s\n' "$NPM_PI_LATEST"; exit 0 ;; # refresh_pi_agent's latest check (issue #223)
esac
printf 'PI install %s\n' "$*" >> "$ORDER_LOG"
mkdir -p "$NPM_CONFIG_PREFIX/bin"
cp "$PI_SHIM_SRC" "$NPM_CONFIG_PREFIX/bin/pi"
EOF
chmod +x "$NEW_NODE_DIR/npm"
export ORDER_LOG PI_SHIM_SRC
NPM_PI_LATEST="1.0.0"; export NPM_PI_LATEST

# env file (as bootstrap writes it) + config.json pointing at a private repo/ref
cat > "$PD_HOME/env" <<EOF
PD_HOME="$PD_HOME"
PD_SRC="$PD_SRC"
PD_NODE="$OLD_NODE_DIR/node"
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
set_pd_node() { # set_pd_node <node-path> — (re)write the env file's PD_NODE
  grep -v '^PD_NODE=' "$PD_HOME/env" > "$PD_HOME/env.tmp" 2>/dev/null || :
  printf 'PD_NODE="%s"\n' "$1" >> "$PD_HOME/env.tmp"
  mv -f "$PD_HOME/env.tmp" "$PD_HOME/env"
}
stub_node_refresh() { # stub_node_refresh [node-dir] — deps.sh stub: "install" this node (+ ensure_pnpm)
  _snr_dir=${1:-$NEW_NODE_DIR}
  cat > "$PD_HOME/lib/deps.sh" <<EOF
_install_node_tarball() {
  printf 'NODE refresh\\n' >> "\$ORDER_LOG"
  PD_NODE_BIN="$_snr_dir/node"
  PD_NODE_BIN_DIR="$_snr_dir"
}
ensure_pnpm() { printf 'PNPM ensure\\n' >> "\$ORDER_LOG"; }
EOF
}
stub_node_refresh

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
# The installed pi (issue #223): refresh_pi_agent reads `pi --version` from
# PATH, so the fixture ships the same 1.0.0 shim the npm stub installs.
cp "$PI_SHIM_SRC" "$FAKE_BIN/pi"
chmod +x "$FAKE_BIN/pi"

# Runs an update.sh snippet with the fake git/gh and the fake install layout.
# Usage: run_update <local-sha> <remote-sha|''> <remote-url|''> <snippet>
# HOME is pinned to the fake home so ~/.local/bin writes (the pideck
# symlink the apply path re-creates) land in the tmp tree, not the real one.
run_update() {
  # -u: scrub the legacy node variables (issue #213) — a real box runs this
  # suite from inside `pideck update`'s process, whose ambient environment
  # can carry any stale subset of PD_NODE/PD_NODE_BIN/PD_NODE_BIN_DIR; the
  # tests must see only what the fixture's env file provides.
  env -u PD_NODE -u PD_NODE_BIN -u PD_NODE_BIN_DIR \
    PATH="$FAKE_BIN:$PATH" \
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
  # -u: scrub the legacy node variables (issue #213) — see run_update.
  _rs_local=$1; _rs_remote=$2; shift 2
  env -u PD_NODE -u PD_NODE_BIN -u PD_NODE_BIN_DIR \
    PATH="$FAKE_BIN:$PATH" FAKE_LOCAL_SHA="$_rs_local" FAKE_REMOTE_SHA="$_rs_remote" \
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

# --- apply path (fully current → no rebuild, no restart) ---------------------
# The fixture's install is fully current here: node at the pin (no refresh),
# pi 1.0.0 == npm latest (no reinstall, issue #223). Only then does the apply
# take the no-op exit (issues #224/#223 moved the runtime checks BEFORE it).
set_pd_node "$NEW_NODE_DIR/node"

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update); rc=$?
check_eq 'apply when up to date exits 0' '0' "$rc"
check_no_grep 'apply when up to date does not restart the service' 'SVC restart' "$out"
check_grep 'apply when up to date says so' 'up to date' "$out"
check_grep 'apply when up to date records done progress (issue #89)' '"stage":"done"' "$(cat "$PD_HOME/var/update-state.json")"

# --- apply path: stale private node on an up-to-date install (issue #224) ----
# The #224 bug: restart-only (and up-to-date) applies used to skip the node
# freshness check, so the private runtime stayed on v22.14.0 while pi 0.85.1
# refused to run — "Update Requires Newer Node" as a dead end. Every apply
# must now check the private node against PD_NODE_VERSION: refresh when
# older (regardless of whether the source moved), reinstall pi under it,
# then restart.
set_pd_node "$OLD_NODE_DIR/node"
: > "$ORDER_LOG"
rm -f "$PD_HOME/var/update-state.json"

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update); rc=$?
check_eq 'up-to-date apply with a stale node exits 0 (issue #224)' '0' "$rc"
check_eq 'up-to-date stale-node apply refreshes node, reinstalls pi (issue #224)' \
  'NODE refresh
PI install install -g --ignore-scripts @earendil-works/pi-coding-agent' "$(cat "$ORDER_LOG")"
check_grep 'up-to-date stale-node apply restarts the daemon (issue #224)' 'SVC restart' "$out"
check_grep 'up-to-date stale-node apply repoints env PD_NODE (issue #224)' "PD_NODE=\"$NEW_NODE_DIR/node\"" "$(cat "$PD_HOME/env")"
check_grep 'up-to-date stale-node apply ends with done progress (issue #224)' '"stage":"done"' "$(cat "$PD_HOME/var/update-state.json")"

# --- node below the pi floor even at a stale installed pin -------------------
# refresh_node_runtime runs BEFORE refresh_installed_layer, so an install
# whose installed lib still pins a pre-floor Node (PD_NODE_VERSION <
# PD_NODE_MIN_VERSION) compares its old private node against that stale pin
# and used to skip the refresh — the daemon then restarted onto a node that
# crashes every pi session (`zlib.createZstdDecompress is not a function`).
# The pi floor must be enforced regardless of what the installed layer pins.
set_pd_node "$OLD_NODE_DIR/node"
: > "$ORDER_LOG"
out=$(run_update "$LOCAL_SHA" "$REMOTE_SAME" '' '
  PD_LIB="$PD_HOME/lib" # the bare harness shell lacks the shim-set PD_LIB
  PD_NODE_VERSION=22.14.0 # a stale installed-layer pin (pre-floor)
  refresh_node_runtime
  printf "node=%s" "$PD_NODE"
'); rc=$?
check_eq 'node below the pi floor refreshes even at a stale pin' '0' "$rc"
check_grep 'the floor refresh installs the pinned node' 'NODE refresh' "$(cat "$ORDER_LOG")"
check_grep 'the floor refresh repoints the active node' "node=$NEW_NODE_DIR/node" "$out"
check_grep 'the floor refresh repoints env PD_NODE' "PD_NODE=\"$NEW_NODE_DIR/node\"" "$(cat "$PD_HOME/env")"

# --- system node below the pi floor on an up-to-date apply -------------------
# The real-box bug behind this fix: refresh_node_runtime used to return early
# for ANY node outside $PD_HOME/opt ("system node — updates never touch it"),
# so an install whose PD_NODE resolved to a system node 22.14 kept crashing
# every pi session (`zlib.createZstdDecompress is not a function`) no matter
# how current the source was — and `pideck update` reported "up to date"
# without ever fixing it. A system node BELOW PD_NODE_MIN_VERSION must be
# treated exactly like a stale private node: install the pinned private
# runtime, repoint PD_NODE in env, reinstall pi under it, restart — even on
# the fully-current (UPDATE_IDLE) path where the fetch/build/layer refresh
# are all skipped.
SYSNODE_OLD_DIR="$tmp/sysnode-v22.14.0/bin" # outside $PD_HOME/opt on purpose
mkdir -p "$SYSNODE_OLD_DIR"
printf '#!/bin/sh\n[ "$1" = -v ] && printf "v22.14.0\\n"\n' > "$SYSNODE_OLD_DIR/node"
chmod +x "$SYSNODE_OLD_DIR/node"
set_pd_node "$SYSNODE_OLD_DIR/node"
: > "$ORDER_LOG"
rm -f "$PD_HOME/var/update-state.json"

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update); rc=$?
check_eq 'up-to-date apply with a below-floor system node exits 0' '0' "$rc"
check_eq 'below-floor system node is replaced by the private runtime + pi reinstall' \
  'NODE refresh
PI install install -g --ignore-scripts @earendil-works/pi-coding-agent' "$(cat "$ORDER_LOG")"
check_grep 'below-floor system-node apply restarts the daemon' 'SVC restart' "$out"
check_grep 'below-floor system-node apply repoints env PD_NODE' "PD_NODE=\"$NEW_NODE_DIR/node\"" "$(cat "$PD_HOME/env")"
check_grep 'below-floor system-node apply ends with done progress' '"stage":"done"' "$(cat "$PD_HOME/var/update-state.json")"

# A system node AT or ABOVE the floor (even below the pin) is still untouched:
# updates rescue a broken system node, they never replace a healthy one.
SYSNODE_OK_DIR="$tmp/sysnode-v22.20.0/bin"
mkdir -p "$SYSNODE_OK_DIR"
printf '#!/bin/sh\n[ "$1" = -v ] && printf "v22.20.0\\n"\n' > "$SYSNODE_OK_DIR/node"
chmod +x "$SYSNODE_OK_DIR/node"
set_pd_node "$SYSNODE_OK_DIR/node"
: > "$ORDER_LOG"
rm -f "$PD_HOME/var/update-state.json"

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update); rc=$?
check_eq 'up-to-date apply with a healthy system node exits 0' '0' "$rc"
check_grep 'healthy system node reports up to date (idle exit)' 'up to date' "$out"
check_no_grep 'healthy system node is never replaced' 'NODE refresh' "$(cat "$ORDER_LOG" 2>/dev/null)"
check_grep 'healthy system node keeps its env PD_NODE' "PD_NODE=\"$SYSNODE_OK_DIR/node\"" "$(cat "$PD_HOME/env")"
check_no_grep 'healthy system node apply does not restart the daemon' 'SVC restart' "$out"

# --- apply path: outdated pi on a current install (issue #223) ---------------
# With the node current, the apply still checks the installed pi version vs
# npm latest and reinstalls when newer (logged old -> new), then restarts.
set_pd_node "$NEW_NODE_DIR/node"
NPM_PI_LATEST="2.0.0"; export NPM_PI_LATEST
printf '%s\n' "$STALE_RUNNING" > "$PD_HOME/var/running-sha" # restart-only apply, node already current
: > "$ORDER_LOG"
rm -f "$PD_HOME/var/update-state.json"

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update); rc=$?
check_eq 'restart-only apply with an outdated pi exits 0 (issue #223)' '0' "$rc"
check_grep 'the pi refresh logs old -> new (issue #223)' 'updating pi (1.0.0 -> 2.0.0)' "$out"
check_grep 'the outdated pi is reinstalled (issue #223)' 'PI install install -g --ignore-scripts @earendil-works/pi-coding-agent' "$(cat "$ORDER_LOG")"
check_grep 'the pi refresh restarts the daemon (issue #223)' 'SVC restart' "$out"
check_grep 'the pi refresh apply ends with done progress (issue #223)' '"stage":"done"' "$(cat "$PD_HOME/var/update-state.json")"

# ...and a current pi leaves the install alone (no reinstall, but the
# restart-only daemon staleness still restarts).
NPM_PI_LATEST="1.0.0"; export NPM_PI_LATEST
: > "$ORDER_LOG"
rm -f "$PD_HOME/var/update-state.json"

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update); rc=$?
check_eq 'restart-only apply with a current pi exits 0 (issue #223)' '0' "$rc"
check_grep 'a current pi is reported, not reinstalled (issue #223)' 'pi is current (1.0.0; npm latest 1.0.0)' "$out"
check_no_grep 'a current pi never triggers an npm install (issue #223)' 'PI install' "$(cat "$ORDER_LOG")"
check_grep 'the restart-only apply still restarts (issue #223)' 'SVC restart' "$out"
rm -f "$PD_HOME/var/running-sha"

# --- apply path: source current but the running build is stale (issue #198) --
# A previous apply can die between the source reset and the restart: the
# source already matches upstream, but the daemon still boots the old build
# (observed live: the daemon's uptime was continuous across two applies).
# The daemon publishes its boot SHA to $PD_HOME/var/running-sha; the apply
# must restart (no fetch/build needed) instead of reporting done.
STALE_RUNNING="3333333333333333333333333333333333333333"
printf '%s\n' "$STALE_RUNNING" > "$PD_HOME/var/running-sha"
out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update); rc=$?
check_eq 'restart-only apply exits 0' '0' "$rc"
check_no_grep 'restart-only apply does not claim up to date' 'up to date' "$out"
check_grep 'restart-only apply notices the stale running build' 'still runs 3333333' "$out"
check_grep 'restart-only apply restarts the service' 'SVC restart' "$out"
check_grep 'restart-only apply records done progress' '"stage":"done"' "$(cat "$PD_HOME/var/update-state.json")"
rm -f "$PD_HOME/var/running-sha"

# --- shim: PD_NODE_BIN derivation (issue #208) -------------------------------
# A plain login shell has no service-env variables; the shim used to crash
# with `PD_NODE_BIN: parameter not set` the moment register_service rendered
# the unit templates. It must derive the runtime itself: env PD_NODE, else
# the NEWEST node-v* dir under $PD_HOME/opt, else PATH node.
grep -v '^PD_NODE=' "$PD_HOME/env" > "$PD_HOME/env.tmp" && mv -f "$PD_HOME/env.tmp" "$PD_HOME/env"
printf '%s\n' "$STALE_RUNNING" > "$PD_HOME/var/running-sha" # restart-only apply: register_service runs
rm -f "$PD_HOME/var/update-state.json"
out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update); rc=$?
check_eq 'shim without service-env PD_NODE_BIN still applies (issue #208)' '0' "$rc"
check_grep 'shim derives the newest private node when env has no PD_NODE (issue #208)' 'node-v22.23.2-linux-x64/bin/node dir=' "$out"
set_pd_node "$OLD_NODE_DIR/node"

# --- shim: fe43fa0-era installed layout (issue #213) -------------------------
# A fe43fa0-era install (pre-#208/#211) has an env file with only PD_NODE —
# no PD_NODE_BIN/PD_NODE_BIN_DIR — and when `pideck update` runs the install
# suite from inside the OLD shim's process, that process's exported legacy
# variables leak into the ambient environment of every child (pnpm build ->
# this suite -> run_shim). Observed live on the dev server: PD_NODE +
# PD_NODE_BIN exported, PD_NODE_BIN_DIR missing -> `PD_NODE_BIN_DIR:
# parameter not set` killed the apply with exit 2. The shim must normalize
# the whole triple on every run regardless of which legacy generation the
# ambient environment carries — it must not skip just because PD_NODE is
# set to something stale. All variants below apply with the env file
# pointing at the OLD private node (which sits under $PD_HOME/opt, so
# refresh_node_runtime legitimately moves it to the pinned one before
# register_service runs — the register output must show the refreshed,
# complete triple either way).
printf '%s\n' "$STALE_RUNNING" > "$PD_HOME/var/running-sha" # restart-only apply: register_service runs

fe43_ambient_apply() { # fe43_ambient_apply <PD_NODE|''> <PD_NODE_BIN|''> <PD_NODE_BIN_DIR|''> — leaky-ambient apply
  _fa_out=$(env PATH="$FAKE_BIN:$PATH" FAKE_LOCAL_SHA="$LOCAL_SHA" FAKE_REMOTE_SHA="$REMOTE_SAME" \
    PD_HOME="$PD_HOME" HOME="$PD_HOME" \
    ${1:+"PD_NODE=$1"} ${2:+"PD_NODE_BIN=$2"} ${3:+"PD_NODE_BIN_DIR=$3"} \
    sh "$SHIM" update 2>&1)
}

# the exact field crash: ambient PD_NODE + PD_NODE_BIN, PD_NODE_BIN_DIR missing
set_pd_node "$OLD_NODE_DIR/node"
fe43_ambient_apply "$OLD_NODE_DIR/node" "$OLD_NODE_DIR/node" ""; rc=$?
check_eq 'fe43fa0 layout: apply survives stale PD_NODE+PD_NODE_BIN with PD_NODE_BIN_DIR missing (issue #213)' '0' "$rc"
check_grep 'fe43fa0 layout: the missing PD_NODE_BIN_DIR is derived from the active node (issue #213)' \
  "node=$NEW_NODE_DIR/node dir=$NEW_NODE_DIR" "$_fa_out"
check_no_grep 'fe43fa0 layout: no parameter-not-set ever reaches the output (issue #213)' 'parameter not set' "$_fa_out"

# the old shim's own export set: ambient PD_NODE only (stale, executable)
set_pd_node "$OLD_NODE_DIR/node"
fe43_ambient_apply "$OLD_NODE_DIR/node" "" ""; rc=$?
check_eq 'fe43fa0 layout: apply survives the old shim PD_NODE-only export set (issue #213)' '0' "$rc"
check_grep 'fe43fa0 layout: stale env-file PD_NODE is normalized into the full triple (issue #213)' \
  "node=$NEW_NODE_DIR/node dir=$NEW_NODE_DIR" "$_fa_out"

# the post-#211 shim's derived set: all three stale but consistent
set_pd_node "$OLD_NODE_DIR/node"
fe43_ambient_apply "$OLD_NODE_DIR/node" "$OLD_NODE_DIR/node" "$OLD_NODE_DIR"; rc=$?
check_eq 'fe43fa0 layout: apply survives a stale-but-complete legacy triple (issue #213)' '0' "$rc"
check_grep 'fe43fa0 layout: a stale complete triple still refreshes and registers (issue #213)' \
  "node=$NEW_NODE_DIR/node dir=$NEW_NODE_DIR" "$_fa_out"

rm -f "$PD_HOME/var/running-sha"

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
check_grep 'shim derives PD_NODE_BIN in a plain shell (issue #208)' 'REGISTER service node=' "$out"

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
check_grep 'failing build records the failure detail (issue #198)' '"error":"build failed"' "$(cat "$PD_HOME/var/update-state.json")"
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
# The copied real deps.sh would make ensure_pnpm_for_build hit the network
# (the build branch now self-heals pnpm); stub it out — the apply's own
# refresh_installed_layer re-copies the clean deps.sh from the fresh tree,
# so the cmp assertions below still see the fetched originals.
printf '\nensure_pnpm() { :; }\n' >> "$PD_HOME/lib/deps.sh"
printf '#!/bin/sh\n# stale shim\n' > "$PD_HOME/bin/pideck"
printf '#!/bin/sh\n# stale launcher\n' > "$PD_HOME/bin/pideck-daemon"
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
cp "$INSTALL_DIR/lib/source.sh" "$PD_HOME/lib/"

# --- apply path: stale real-file ~/.local/bin shims (issue #215) -------------
# Pre-#163 installs copied REAL-file shims into ~/.local/bin
# (install_bin_compat); PATH resolves ~/.local/bin first, so such a file
# shadows the refreshed $PD_HOME/bin shim forever (observed live: a
# fe43fa0-era shim with syntax errors kept breaking the CLI after a
# successful update — the refresh touched ~/.pideck/bin only). After a
# refresh the entries must be canonical symlinks of the installed shims,
# matching the current shim and running cleanly; correct symlinks are a
# no-op and absent entries stay absent (bootstrap owns creation).
stale_lbin="$PD_HOME/.local/bin"
mkdir -p "$PD_SRC/install/bin" "$stale_lbin"
cp "$INSTALL_DIR/bin/pideck" "$INSTALL_DIR/bin/pideck-daemon" "$PD_SRC/install/bin/"
# start from no ~/.local/bin entries: the previous section's apply left a
# canonical pideck symlink there, and `> file` would follow it
cp "$INSTALL_DIR/lib/service.sh" "$PD_HOME/lib/service.sh.real"
cat > "$PD_HOME/lib/service.sh" <<'EOF'
svc_restart() { printf 'SVC restart\n'; }
register_service() { printf 'REGISTER service\n'; }
EOF
rm -f "$stale_lbin/pideck" "$stale_lbin/pideck-daemon"
# fe43fa0-era compat copies: real files whose content is an old shim
# generation (the live breakage — syntax errors while main's shim is clean).
printf '#!/bin/sh\nPD_NODE_BIN_DIR: parameter not set\n;; garbage\n' > "$stale_lbin/pideck"
printf '#!/bin/sh\n# stale fe43fa0-era daemon launcher\n' > "$stale_lbin/pideck-daemon"
printf '#!/bin/sh\n# stale installed shim (pre-refresh)\n' > "$PD_HOME/bin/pideck"
printf '%s\n' "$STALE_RUNNING" > "$PD_HOME/var/running-sha" # restart-only apply: the refresh still runs
rm -f "$PD_HOME/var/update-state.json"

out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update 2>&1); rc=$?
check_eq 'stale local-bin apply exits 0 (issue #215)' '0' "$rc"
check_grep 'stale real-file ~/.local/bin/pideck is converted (issue #215)' \
  'replacing stale ~/.local/bin/pideck with a symlink' "$out"

if [ -L "$stale_lbin/pideck" ] && [ "$(readlink "$stale_lbin/pideck")" = "$PD_HOME/bin/pideck" ]; then
  printf 'ok - stale real-file ~/.local/bin/pideck is the canonical symlink\n'
else
  printf 'not ok - stale real-file ~/.local/bin/pideck was not converted (issue #215)\n'
  failures=$((failures + 1))
fi
if cmp -s "$INSTALL_DIR/bin/pideck" "$stale_lbin/pideck"; then
  printf 'ok - converted ~/.local/bin/pideck matches the current shim\n'
else
  printf 'not ok - converted ~/.local/bin/pideck does not match the current shim\n'
  failures=$((failures + 1))
fi
if [ -L "$stale_lbin/pideck-daemon" ] && [ "$(readlink "$stale_lbin/pideck-daemon")" = "$PD_HOME/bin/pideck-daemon" ]; then
  printf 'ok - stale real-file ~/.local/bin/pideck-daemon is the canonical symlink\n'
else
  printf 'not ok - stale real-file ~/.local/bin/pideck-daemon was not converted (issue #215)\n'
  failures=$((failures + 1))
fi
if cmp -s "$INSTALL_DIR/bin/pideck-daemon" "$stale_lbin/pideck-daemon"; then
  printf 'ok - converted ~/.local/bin/pideck-daemon matches the current shim\n'
else
  printf 'not ok - converted ~/.local/bin/pideck-daemon does not match the current shim\n'
  failures=$((failures + 1))
fi

out=$(env -u PD_NODE -u PD_NODE_BIN -u PD_NODE_BIN_DIR \
  PATH="$FAKE_BIN:$PATH" PD_HOME="$PD_HOME" HOME="$PD_HOME" \
  "$stale_lbin/pideck" help 2>&1); rc=$?
check_eq 'converted ~/.local/bin/pideck runs cleanly (issue #215)' '0' "$rc"
check_grep 'converted shim serves help' 'control the PiDeck daemon/webapp' "$out"
check_no_grep 'the stale shim content is gone (issue #215)' 'parameter not set' "$out"

# Idempotency + absence semantics: a maintained symlink is a no-op on the
# next refresh, and a missing entry is left for bootstrap to create.
rm -f "$stale_lbin/pideck-daemon"
printf '%s\n' "$STALE_RUNNING" > "$PD_HOME/var/running-sha"
rm -f "$PD_HOME/var/update-state.json"
out=$(run_shim "$LOCAL_SHA" "$REMOTE_SAME" update 2>&1); rc=$?
check_eq 'second refresh with maintained local-bin exits 0 (issue #215)' '0' "$rc"
check_no_grep 'a correct symlink is a refresh no-op (issue #215)' 'replacing stale' "$out"
if [ ! -e "$stale_lbin/pideck-daemon" ] && [ ! -L "$stale_lbin/pideck-daemon" ]; then
  printf 'ok - absent ~/.local/bin/pideck-daemon left for bootstrap (issue #215)\n'
else
  printf 'not ok - refresh created the absent ~/.local/bin/pideck-daemon entry (issue #215)\n'
  failures=$((failures + 1))
fi
if [ -L "$stale_lbin/pideck" ] && [ "$(readlink "$stale_lbin/pideck")" = "$PD_HOME/bin/pideck" ]; then
  printf 'ok - maintained ~/.local/bin/pideck symlink survives the next refresh\n'
else
  printf 'not ok - maintained ~/.local/bin/pideck symlink lost after the next refresh\n'
  failures=$((failures + 1))
fi
rm -rf "$PD_SRC/install" "$PD_HOME/var/running-sha"
mv "$PD_HOME/lib/service.sh.real" "$PD_HOME/lib/service.sh"

# --- apply path: node refresh + pi reinstall ordering (issue #202) ----------
# An apply that advances the Node pin must refresh the private node, THEN
# reinstall the pi npm package under it, THEN restart the daemon — the
# #201-era restart skipped the pi reinstall and every spawned pi session
# crashed with `zlib.createZstdDecompress is not a function`.
#
# Setup: point PD_NODE back at the fake old node (earlier applies already
# refreshed it), re-stub deps.sh to "install" the new node, and make the
# service stub record the restart in ORDER_LOG. The shared ORDER_LOG must
# then read: PNPM ensure, NODE refresh, PI install, SVC restart — in that
# order (pnpm first: the build path self-heals it before the build).
set_pd_node "$OLD_NODE_DIR/node"
stub_node_refresh
cat > "$PD_HOME/lib/service.sh" <<EOF
svc_restart() { printf 'SVC restart\\n' >> "\$ORDER_LOG"; }
register_service() { :; }
EOF
cat > "$PD_HOME/lib/source.sh" <<'EOF'
resolve_source() { :; }
build_from_source() { :; }
EOF
rm -f "$PD_HOME/var/update-state.json" "$ORDER_LOG"

out=$(env FAKE_LOCAL_SHA="$LOCAL_SHA" FAKE_REMOTE_SHA="$REMOTE_NEW" \
  PD_HOME="$PD_HOME" HOME="$PD_HOME" PATH="$FAKE_BIN:$PATH" sh "$SHIM" update); rc=$?
check_eq 'node+pi apply exits 0' '0' "$rc"
check_eq 'ordering is pnpm self-heal -> node refresh -> pi reinstall -> daemon restart' \
  'PNPM ensure
NODE refresh
PI install install -g --ignore-scripts @earendil-works/pi-coding-agent
SVC restart' "$(cat "$ORDER_LOG")"
check_grep 'env PD_NODE repointed to the refreshed runtime' "PD_NODE=\"$NEW_NODE_DIR/node\"" "$(cat "$PD_HOME/env")"
check_grep 'node+pi apply ends with done progress' '"stage":"done"' "$(cat "$PD_HOME/var/update-state.json")"

# --- apply path: pi engines check refuses a too-old node (issue #202) -------
# When the node that would run pi is below pi's engines floor (22.19.0),
# the apply must die BEFORE the restart instead of rebooting the daemon
# into guaranteed pi crashes.
stub_node_refresh "$OLD_NODE_DIR" # refresh "succeeds" but the runtime stays v22.14.0
set_pd_node "$OLD_NODE_DIR/node"
rm -f "$PD_HOME/var/update-state.json" "$ORDER_LOG"

out=$(env FAKE_LOCAL_SHA="$LOCAL_SHA" FAKE_REMOTE_SHA="$REMOTE_NEW" \
  PD_HOME="$PD_HOME" HOME="$PD_HOME" PATH="$FAKE_BIN:$PATH" sh "$SHIM" update 2>&1); rc=$?
check_eq 'too-old-node apply exits nonzero' '1' "$rc"
check_grep 'too-old-node apply explains the engines floor' 'Node >= 22.19.0' "$out"
check_grep 'too-old-node apply names the active node' 'v22.14.0' "$out"
check_grep 'too-old-node apply records failed progress' '"stage":"failed"' "$(cat "$PD_HOME/var/update-state.json")"
check_no_grep 'too-old-node apply never restarts the daemon' 'SVC restart' "$(cat "$ORDER_LOG" 2>/dev/null)"
check_no_grep 'too-old-node apply never installs pi' 'PI install' "$(cat "$ORDER_LOG" 2>/dev/null)"

# --- apply path: corrupt/missing source checkout self-heals (issue #221) -----
# A crashed apply (or manual rm) can leave ~/.pideck/src missing or corrupt:
# `git rev-parse HEAD` fails, every update check errors, and only a manual
# rm -rf + installer re-run used to recover. The apply must detect the dead
# checkout, re-clone it via the installer's own resolve_source, and — since a
# fresh clone has no build artifacts — always rebuild + refresh + restart
# instead of taking the early "up to date" exit.
set_pd_node "$OLD_NODE_DIR/node"
stub_node_refresh
cat > "$PD_HOME/lib/service.sh" <<'EOF'
svc_restart() { printf 'SVC restart\n'; }
register_service() { printf 'REGISTER service\n'; }
EOF
cat > "$PD_HOME/lib/source.sh" <<EOF
resolve_source() {
  # "re-clone": rebuild a fresh tree at \$PD_SRC (where update.sh pointed it)
  # with the current revision — mimicking the real fetch + reset --hard.
  mkdir -p "\$PD_SRC/install/bin" "\$PD_SRC/install/lib" "\$PD_SRC/install/service"
  cp "$INSTALL_DIR/lib/"*.sh "\$PD_SRC/install/lib/"
  cp "$INSTALL_DIR/onboard.sh" "\$PD_SRC/install/onboard.sh"
  cp "$INSTALL_DIR/bin/pideck" "$INSTALL_DIR/bin/pideck-daemon" "\$PD_SRC/install/bin/"
  FAKE_LOCAL_SHA="$LOCAL_SHA"; export FAKE_LOCAL_SHA
  printf 'RESOLVE re-clone %s\n' "\$PD_REPO_REF"
}
build_from_source() { printf 'BUILD\n'; }
EOF
rm -f "$PD_HOME/var/running-sha" "$PD_HOME/var/update-state.json"

out=$(run_shim "" "$REMOTE_SAME" update 2>&1); rc=$?
check_eq 'self-heal apply exits 0 (issue #221)' '0' "$rc"
check_grep 'self-heal apply notices the dead checkout (issue #221)' 'missing or corrupt' "$out"
check_grep 'self-heal apply re-clones via resolve_source (issue #221)' 'RESOLVE re-clone dev-branch' "$out"
check_grep 'self-heal apply rebuilds the fresh clone (issue #221)' 'BUILD' "$out"
check_grep 'self-heal apply refreshes the installed layer (issue #221)' 'installed shell layer refreshed' "$out"
check_grep 'self-heal apply restarts the daemon (issue #221)' 'SVC restart' "$out"
check_grep 'self-heal apply ends with done progress (issue #221)' '"stage":"done"' "$(cat "$PD_HOME/var/update-state.json")"

# A re-clone that fails (or still leaves no usable revision) must fall back
# to the honest check error + failed progress — not loop or fake success.
rm -f "$PD_HOME/config.json"
cat > "$PD_HOME/lib/source.sh" <<'EOF'
resolve_source() { return 1; }
build_from_source() { printf 'BUILD\n'; }
EOF
out=$(run_shim "" "$REMOTE_SAME" update 2>&1); rc=$?
check_eq 'failed re-clone apply exits nonzero (issue #221)' '1' "$rc"
check_grep 'failed re-clone apply keeps the honest check error (issue #221)' 'cannot apply an update' "$out"
check_grep 'failed re-clone apply records failed progress (issue #221)' '"stage":"failed"' "$(cat "$PD_HOME/var/update-state.json")"
check_no_grep 'failed re-clone apply never rebuilds (issue #221)' 'BUILD' "$out"
write_config

# --- summary ----------------------------------------------------------------
if [ "$failures" -eq 0 ]; then
  printf '# all update tests passed\n'
  exit 0
fi
printf '# %s update test(s) failed\n' "$failures"
exit 1
