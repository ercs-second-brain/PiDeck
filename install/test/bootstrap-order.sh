#!/bin/sh
# shellcheck shell=sh disable=SC2154 # failures comes from the sourced harness
# Plain-shell test for the bootstrap ordering (issue #207): the CLI shims +
# ~/.local/bin symlink and the ~/.pideck env/config must be installed BEFORE
# build_from_source, so a failed build leaves a recoverable CLI
# (pideck status / pideck update) instead of `pideck: command not found`.
#
# Runs the bootstrap with --dry-run against a fake monorepo checkout
# (--dir) with fake git/node/pnpm/gh/pi shims on PATH, then asserts on the
# order of the dry-run markers: CLI install + env/config write < build.
set -u

# shellcheck disable=SC1091 # shared test harness, sourced on purpose
. "$(dirname -- "$0")/harness.sh"

check_lt() { # check_lt <name> <line-a> <line-b> (a must come before b)
  if [ "$2" -gt 0 ] && [ "$3" -gt 0 ] && [ "$2" -lt "$3" ]; then
    printf 'ok - %s\n' "$1"
  else
    printf 'not ok - %s\n     first marker line:  %s\n     second marker line: %s\n' "$1" "$2" "$3"
    failures=$((failures + 1))
  fi
}

line_of() { # line_of <needle> <file> -> first 1-based line containing needle
  grep -n -F -- "$1" "$2" 2>/dev/null | head -n 1 | cut -d: -f1
}

# --- fake monorepo checkout (the --dir source) -----------------------------
src="$tmp/src"
PD_HOME="$tmp/home/.pideck"
mkdir -p "$src/apps/daemon/dist" "$src/install/bin" "$src/install/lib" "$PD_HOME/bin"
: > "$src/apps/daemon/dist/index.js" # dry-run build still verifies the entry
printf '#!/bin/sh\n' > "$src/install/bin/pideck"
: > "$src/install/lib/common.sh"
: > "$src/install/onboard.sh"
mkdir -p "$src/install/service"
cp "$INSTALL_DIR/service/"* "$src/install/service/"

# --- fake toolchain: git/node/pnpm/gh/pi, so the deps phase never installs --
fakebin="$tmp/fakebin"
mkdir -p "$fakebin"
# Single-quoted on purpose: these heredoc-free bodies are written verbatim.
# shellcheck disable=SC2016
printf '#!/bin/sh\ncase "$1" in -v|--version) echo "git version 2.45.0";; esac\n' > "$fakebin/git"
# shellcheck disable=SC2016
printf '#!/bin/sh\ncase "$1" in -v) echo "v22.23.2";; esac\n' > "$fakebin/node"
# shellcheck disable=SC2016
printf '#!/bin/sh\ncase "$1" in --version) echo "10.12.0";; esac\n' > "$fakebin/pnpm"
# shellcheck disable=SC2016
printf '#!/bin/sh\ncase "$1" in --version) echo "gh version 2.63.2";; esac\n' > "$fakebin/gh"
# shellcheck disable=SC2016
printf '#!/bin/sh\ncase "$1" in --version) echo "0.75.0";; esac\n' > "$fakebin/pi"
chmod +x "$fakebin"/*

# --- dry-run bootstrap ------------------------------------------------------
# PD_BOOTSTRAP_REEXEC=1 skips the `curl | sh` re-exec (stdin is not a tty
# here); HOME is sandboxed so rc-file writes and ~/.local/bin stay in $tmp.
out="$tmp/bootstrap.out"
HOME="$tmp/home" PATH="$fakebin:$PATH" PD_BOOTSTRAP_REEXEC=1 PD_HOME="$PD_HOME" \
  sh "$INSTALL_DIR/bootstrap.sh" --dry-run --no-onboard --dir "$src" > "$out" 2>&1
check_eq "dry-run bootstrap exits 0" 0 "$?"

# --- ordering: CLI install + env/config write BEFORE the build --------------
cli_bin=$(line_of "'cp' '$src/install/bin/pideck'" "$out")
symlink=$(line_of "'ln' '-sfn' '$PD_HOME/bin/pideck' '$tmp/home/.local/bin/pideck'" "$out")
env_write=$(line_of "[dry-run] write $PD_HOME/env" "$out")
build=$(line_of "building pideck from source" "$out")

check_lt "pideck bin copy comes before the build" "$cli_bin" "$build"
check_lt "local-bin pideck symlink comes before the build" "$symlink" "$build"
check_lt "env/config write comes before the build" "$env_write" "$build"

exit "$failures"
