#!/bin/sh
# shellcheck shell=sh disable=SC2154,SC2034 # failures comes from the sourced harness
# Plain-shell test for bootstrap --dry-run on a BARE box: node, gh, pi and
# pnpm ABSENT from PATH. A dry-run must print every step and exit 0 — it
# dies while "installing" is useless for previewing an install on a fresh
# machine. No network, no real installs (everything is printed, not run).
set -u

# shellcheck disable=SC1091 # shared test harness, sourced on purpose
. "$(dirname -- "$0")/harness.sh"

# --- fake monorepo checkout (the --dir source): a copy of install/ ---------
src="$tmp/src"
mkdir -p "$src/install"
cp -R "$INSTALL_DIR/bin" "$INSTALL_DIR/lib" "$INSTALL_DIR/service" "$src/install/"
cp "$INSTALL_DIR/bootstrap.sh" "$INSTALL_DIR/onboard.sh" "$INSTALL_DIR/uninstall.sh" "$src/install/"
mkdir -p "$src/apps/daemon/dist" "$src/agent/skills/demo"
: > "$src/apps/daemon/dist/index.js"
printf 'demo skill\n' > "$src/agent/skills/demo/SKILL.md"

# --- bare toolchain: the system dirs MINUS node/npm/npx/corepack/pnpm/gh/pi -
# ~/.local/bin is excluded entirely, so nothing user-installed leaks in.
barebin="$tmp/barebin"
mkdir -p "$barebin"
for _d in /usr/bin /bin /usr/local/bin; do
  [ -d "$_d" ] || continue
  for _f in "$_d"/*; do
    _b=$(basename "$_f")
    case "$_b" in
      node | npm | npx | corepack | pnpm | gh | pi) continue ;;
    esac
    [ -e "$barebin/$_b" ] || ln -s "$_f" "$barebin/$_b" 2>/dev/null || :
  done
done
BARE_PATH="$barebin"
for _tool in node gh pi pnpm; do
  if env PATH="$BARE_PATH" sh -c "command -v $_tool >/dev/null 2>&1"; then
    printf 'not ok - test setup: %s still on the bare PATH\n' "$_tool"
    exit 1
  fi
done
printf 'ok - test setup: bare PATH has no node/gh/pi/pnpm\n'

# --- dry-run bootstrap on the bare box --------------------------------------
out="$tmp/bootstrap-bare.out"
HOME="$tmp/home" PATH="$BARE_PATH" PD_BOOTSTRAP_REEXEC=1 PD_HOME="$tmp/home/.pideck" \
  sh "$src/install/bootstrap.sh" --dry-run --no-onboard --dir "$src" > "$out" 2>&1
rc=$?
check_eq "dry-run bootstrap on a bare box exits 0" 0 "$rc"
if [ "$rc" != "0" ]; then
  sed -n '1,60p' "$out" >&2
fi
out_body=$(cat "$out")
check_no_grep "no error lines on the bare box" "error:" "$out_body"
check_grep "node install step printed" "[dry-run] install Node.js" "$out_body"
check_grep "gh install step printed" "[dry-run] install gh" "$out_body"
check_grep "pnpm install step printed" "[dry-run] install standalone pnpm" "$out_body"
check_grep "pi install step printed" "[dry-run] npm install -g --ignore-scripts" "$out_body"
check_grep "build step printed" "[dry-run] 'pnpm' 'install' '--frozen-lockfile'" "$out_body"
check_grep "service registration printed" "[dry-run] render" "$out_body"
check_grep "bootstrap summary reached" "PiDeck installed" "$out_body"

exit "$failures"
