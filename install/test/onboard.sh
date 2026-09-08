#!/bin/sh
# shellcheck shell=sh disable=SC2154 # failures comes from the sourced harness
# Plain-shell regression test for issue #61: onboard.sh must run from the
# flat installed layout. bootstrap.sh copies install/lib/*.sh AND
# install/onboard.sh side by side into ~/.pideck/lib/ — onboard.sh must
# find its libs there (sibling sourcing), not only in the source tree layout
# (lib/ subdir). Runs onboard.sh --dry-run from the copied location; no
# network, no real pi/gh/auth side effects.
set -u

# shellcheck disable=SC1091 # shared test harness, sourced on purpose
. "$(dirname -- "$0")/harness.sh"

# --- flat installed layout, replicated exactly as bootstrap.sh does it ------
# (bootstrap.sh: `cp install/lib/*.sh install/onboard.sh -> $PD_HOME/lib/`,
# all flat, no subdirectory)
PD_HOME="$tmp/home"
mkdir -p "$PD_HOME/lib"
cp "$INSTALL_DIR/lib/"*.sh "$PD_HOME/lib/"
cp "$INSTALL_DIR/onboard.sh" "$PD_HOME/lib/"
if [ -f "$PD_HOME/lib/onboard.sh" ] && [ -f "$PD_HOME/lib/common.sh" ] && [ ! -d "$PD_HOME/lib/lib" ]; then :; else
  printf 'not ok - test setup: flat copy of install/ into %s/lib\n' "$PD_HOME"
  exit 1
fi

# Isolate from the real ~/.pideck (common.sh honors PD_HOME).
export PD_HOME

# --- installed layout: onboard.sh runs from $PD_HOME/lib --------------------
out=$(sh "$PD_HOME/lib/onboard.sh" --dry-run --skip-pi --skip-gh 2>&1)
rc=$?
check_eq 'installed layout: onboard.sh --dry-run exits 0' '0' "$rc"
check_grep 'installed layout: onboarding ran' 'onboarding summary' "$out"
check_grep 'installed layout: dry-run honored' '[dry-run] write' "$out"

# --- source-tree layout: install/onboard.sh with install/lib/ sibling -------
PD_ALT_HOME="$tmp/alt-home"
PD_HOME="$PD_ALT_HOME"
export PD_HOME
out=$(sh "$INSTALL_DIR/onboard.sh" --dry-run --skip-pi --skip-gh 2>&1)
rc=$?
check_eq 'source-tree layout: onboard.sh --dry-run exits 0' '0' "$rc"
check_grep 'source-tree layout: onboarding ran' 'onboarding summary' "$out"

# --- issue #165: an incomplete onboarding never ends silently ---------------
# Noninteractive run from the installed layout (gh skipped; pi either
# unauthenticated or absent on the test host — both leave pi auth
# incomplete): the output must prominently carry the exact follow-up command.
PD_HOME="$tmp/home"
export PD_HOME
out=$(sh "$PD_HOME/lib/onboard.sh" --noninteractive --skip-gh 2>&1)
rc=$?
check_eq 'incomplete onboarding exits 0' '0' "$rc"
check_grep 'incomplete onboarding: prominent NEXT STEP marker' 'NEXT STEP' "$out"
check_grep 'incomplete onboarding: exact follow-up command' 'pideck onboard' "$out"

exit "$failures"
