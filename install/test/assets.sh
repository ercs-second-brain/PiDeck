#!/bin/sh
# shellcheck shell=sh disable=SC2154,SC1091 # failures comes from the sourced harness
# Plain-shell tests for lib/assets.sh's agent-asset linking (issue #460): a
# re-run after an upgrade must prune the stale symlinks of assets the
# checkout no longer ships — the seven shipped global integration skills
# #439 removed — while keeping live links and never touching entries this
# install does not own (user-owned dirs, links pointing elsewhere). Without
# the prune, pi reports every dangling link as "skill path does not exist"
# on each session load.
set -u

# shellcheck disable=SC1091 # shared test harness, sourced on purpose
. "$(dirname -- "$0")/harness.sh"

export HOME="$tmp/home"
PD_HOME="$tmp/pd-home"
PD_SRC="$tmp/src"
PD_PI_DIR="$tmp/pi/agent"
PD_DRY_RUN=0
export PD_DRY_RUN PD_HOME PD_SRC
mkdir -p "$PD_SRC/agent/skills" "$PD_PI_DIR/skills"

# shellcheck disable=SC1091 # installer lib, sourced on purpose
. "$INSTALL_DIR/lib/common.sh"
. "$INSTALL_DIR/lib/assets.sh"

make_skill() { # make_skill <name>
  mkdir -p "$PD_SRC/agent/skills/$1"
  printf -- '---\nname: %s\n---\n' "$1" > "$PD_SRC/agent/skills/$1/SKILL.md"
}

# Arbitrary skill names the "checkout" stops shipping across the upgrade —
# generated, not a memorial list: the prune is generic over whatever an
# install removed (issue #463). One skill stays live.
REMOVED="stale-a stale-b stale-c stale-d stale-e stale-f stale-g"
LIVE="bash-triage"

# --- first install: every shipped dir gets a symlink ------------------------
for _s in $LIVE $REMOVED; do make_skill "$_s"; done
install_agent_assets >"$tmp/install1.out" 2>&1
for _s in $LIVE $REMOVED; do
  check_eq "first install links $_s" "$PD_SRC/agent/skills/$_s" "$(readlink "$PD_PI_DIR/skills/$_s")"
done

# --- upgrade: the checkout stops shipping the stale dirs -------------------
for _s in $REMOVED; do
  rm -rf "$PD_SRC/agent/skills/$_s"
done
install_agent_assets > "$tmp/install2.out" 2>&1
check_eq "upgrade re-run exits 0" 0 "$?"

for _s in $REMOVED; do
  if [ -e "$PD_PI_DIR/skills/$_s" ] || [ -L "$PD_PI_DIR/skills/$_s" ]; then
    printf 'not ok - stale link %s pruned on upgrade\n' "$_s"
    failures=$((failures + 1))
  else
    printf 'ok - stale link %s pruned on upgrade\n' "$_s"
  fi
done

check_eq "live skill link survives the prune" "$PD_SRC/agent/skills/bash-triage" "$(readlink "$PD_PI_DIR/skills/bash-triage")"
check_eq "live skill link still resolves" "$PD_SRC/agent/skills/bash-triage/SKILL.md" "$(readlink -f "$PD_PI_DIR/skills/bash-triage/SKILL.md")"

# --- entries this install does not own are never pruned ---------------------
# A dangling symlink pointing OUTSIDE $PD_SRC/agent (user-owned) must
# survive every prune.
other="$tmp/other-skill"
mkdir -p "$other"
ln -s "$other/gone" "$PD_PI_DIR/skills/foreign-link"
install_agent_assets > "$tmp/install3.out" 2>&1
check_eq "foreign dangling symlink survives the prune" "$other/gone" "$(readlink "$PD_PI_DIR/skills/foreign-link")"

exit "$failures"