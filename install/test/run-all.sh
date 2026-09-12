#!/bin/sh
# Runs every install/test suite and reports one overall verdict. Suites are
# plain-shell scripts (no bats dependency); each prints its own ok/not-ok
# lines. Exits nonzero when any suite failed.
#
#   sh install/test/run-all.sh
set -u

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

total_fail=0
for suite in "$SCRIPT_DIR"/*.sh; do
  [ "$(basename "$suite")" = "run-all.sh" ] && continue
  printf '\n=== %s ===\n' "$(basename "$suite")"
  if sh "$suite"; then
    :
  else
    printf 'SUITE FAILED: %s\n' "$(basename "$suite")" >&2
    total_fail=$((total_fail + 1))
  fi
done

printf '\n'
if [ "$total_fail" -eq 0 ]; then
  printf 'all install test suites passed\n'
  exit 0
fi
printf '%s install test suite(s) failed\n' "$total_fail" >&2
exit 1
