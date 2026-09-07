#!/bin/sh
# Plain-shell regression test for issue #61: onboard.sh must run from the
# flat installed layout. bootstrap.sh copies install/lib/*.sh AND
# install/onboard.sh side by side into ~/.agentskiss/lib/ — onboard.sh must
# find its libs there (sibling sourcing), not only in the source tree layout
# (lib/ subdir). Runs onboard.sh --dry-run from the copied location; no
# network, no real pi/gh/auth side effects.
set -u

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTALL_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)

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

# --- flat installed layout, replicated exactly as bootstrap.sh does it ------
# (bootstrap.sh: `cp install/lib/*.sh install/onboard.sh -> $AK_HOME/lib/`,
# all flat, no subdirectory)
AK_HOME="$tmp/home"
mkdir -p "$AK_HOME/lib"
cp "$INSTALL_DIR/lib/"*.sh "$AK_HOME/lib/"
cp "$INSTALL_DIR/onboard.sh" "$AK_HOME/lib/"
[ -f "$AK_HOME/lib/onboard.sh" ] && [ -f "$AK_HOME/lib/common.sh" ] && [ ! -d "$AK_HOME/lib/lib" ] ||
  { printf 'not ok - test setup: flat copy of install/ into %s/lib\n' "$AK_HOME"; exit 1; }

# Isolate from the real ~/.agentskiss (common.sh honors AGENTSKISS_HOME).
AGENTSKISS_HOME="$AK_HOME"
export AGENTSKISS_HOME

# --- installed layout: onboard.sh runs from $AK_HOME/lib --------------------
out=$(sh "$AK_HOME/lib/onboard.sh" --dry-run --skip-pi --skip-gh 2>&1)
rc=$?
check_eq 'installed layout: onboard.sh --dry-run exits 0' '0' "$rc"
check_grep 'installed layout: onboarding ran' 'onboarding summary' "$out"
check_grep 'installed layout: dry-run honored' '[dry-run] write' "$out"

# --- source-tree layout: install/onboard.sh with install/lib/ sibling -------
AK_ALT_HOME="$tmp/alt-home"
AGENTSKISS_HOME="$AK_ALT_HOME"
export AGENTSKISS_HOME
out=$(sh "$INSTALL_DIR/onboard.sh" --dry-run --skip-pi --skip-gh 2>&1)
rc=$?
check_eq 'source-tree layout: onboard.sh --dry-run exits 0' '0' "$rc"
check_grep 'source-tree layout: onboarding ran' 'onboarding summary' "$out"

exit "$failures"
