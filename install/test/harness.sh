# shellcheck shell=sh
#
# Shared test harness for install/test/*.sh (plain shell, no bats
# dependency). Provides the script paths (all test scripts live next to this
# file), a temp dir with cleanup, and the tiny check_* assertion helpers.
# Source it right after `set -u`; exit with "$failures".

failures=0

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
INSTALL_DIR=$(CDPATH='' cd -- "$SCRIPT_DIR/.." && pwd)
# shellcheck disable=SC2034 # consumed by the sourcing test scripts
SHIM="$INSTALL_DIR/bin/pideck"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

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
