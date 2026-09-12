#!/bin/sh
# shellcheck shell=sh disable=SC1091
#
# PiDeck one-line installer entrypoint.
#
#   curl -fsSL https://raw.githubusercontent.com/ercs-second-brain/PiDeck/main/install/bootstrap.sh | sh
#
# Works when piped (curl | sh) and when run from a checkout. Flow:
#   1. detect OS (macOS or Linux)
#   2. install git, Node 22, pnpm, gh (user-level, no sudo on the main path)
#   3. fetch the monorepo source
#   4. install the pideck CLI bins + ~/.local/bin symlink and write
#      config/state to ~/.pideck/ — BEFORE the build, so a failed build
#      still leaves a recoverable CLI (pideck service status / update)
#   5. build daemon + webapp
#   6. install the pi coding agent
#   7. symlink the pideck pi skills from agent/skills/
#   8. register the persistent service (launchd / systemd user unit)
#   9. run guided onboarding (pi auth + model, gh auth, review account)
#      unless --no-onboard
#
# Flags:
#   --dry-run       print mutating commands instead of running them
#   --no-onboard    skip the interactive onboarding step
#   --repo URL      monorepo git URL (default: ercs-second-brain/PiDeck)
#   --ref REF       branch/tag to install (default: main)
#   --dir PATH      use an existing checkout instead of cloning
#   --port N        webapp port (default: 8321)
#   -h, --help

set -u

usage() {
  cat <<'EOF'
Usage: bootstrap.sh [--dry-run] [--no-onboard] [--repo URL] [--ref REF] [--dir PATH] [--port N]

  --dry-run       print every mutating step instead of running it
  --no-onboard    skip interactive onboarding
  --repo URL      monorepo git URL        (default: ercs-second-brain/PiDeck)
  --ref REF       branch/tag to install   (default: main)
  --dir PATH      build from an existing checkout
  --port N        webapp port             (default: 8321)
  -h, --help      show this help
EOF
}

# ---------------------------------------------------------------------------
# `curl | sh` handling. MUST run before flag parsing and MUST fetch the
# source first: stdin is the pipe (so interactive prompts would eat the
# script), and the re-exec needs the repo on disk before any flag (or the
# default --repo/--ref) can act on it. Unpack the repo tarball, then re-exec
# this same script from disk with tty stdin restored and the original flags
# forwarded.
# ---------------------------------------------------------------------------
if [ ! -t 0 ] && [ "${PD_BOOTSTRAP_REEXEC:-0}" != "1" ]; then
  _pb_repo="${PD_REPO_URL:-https://github.com/ercs-second-brain/PiDeck.git}"
  _pb_ref="${PD_REPO_REF:-main}"
  # Neutral temp dir, NOT the install home (the child runs from it; exec
  # never returns, so it is left behind — /tmp cleans it up).
  _pb_tmp="${TMPDIR:-/tmp}/pideck-bootstrap.$$.tmp"
  mkdir -p "$_pb_tmp"
  printf '==> piped install detected: fetching source (%s) to re-run interactively\n' "$_pb_ref"
  _pb_slug=$(printf '%s' "$_pb_repo" | sed -e 's#^https://github.com/##' -e 's#\.git$##')
  _pb_dir=""
  if printf '%s' "$_pb_repo" | grep -q '^https://github.com/' &&
    curl -fsSL "https://github.com/$_pb_slug/archive/$_pb_ref.tar.gz" -o "$_pb_tmp/src.tar.gz" 2>/dev/null; then
    tar -xzf "$_pb_tmp/src.tar.gz" -C "$_pb_tmp"
    rm -f "$_pb_tmp/src.tar.gz"
    _pb_dir=$(find "$_pb_tmp" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  elif command -v git >/dev/null 2>&1; then
    git clone --depth 1 --branch "$_pb_ref" "$_pb_repo" "$_pb_tmp/src" && _pb_dir="$_pb_tmp/src"
  fi
  if [ -z "$_pb_dir" ] || [ ! -f "$_pb_dir/install/bootstrap.sh" ]; then
    printf 'error: could not fetch the pideck source (%s)\n' "$_pb_repo" >&2
    exit 1
  fi
  PD_BOOTSTRAP_REEXEC=1
  export PD_BOOTSTRAP_REEXEC
  exec sh "$_pb_dir/install/bootstrap.sh" "$@" </dev/tty
fi

# ---------------------------------------------------------------------------
# Load full helpers and parse flags.
# ---------------------------------------------------------------------------
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd)
. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lib/deps.sh"
. "$SCRIPT_DIR/lib/source.sh"
. "$SCRIPT_DIR/lib/assets.sh"
. "$SCRIPT_DIR/lib/service.sh"

PD_SRC_DIR=""
PD_NO_ONBOARD=0
# PD_SRC_DIR is consumed by resolve_source() from lib/source.sh.
# shellcheck disable=SC2034
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) PD_DRY_RUN=1 ;;
    --no-onboard) PD_NO_ONBOARD=1 ;;
    --repo) [ $# -ge 2 ] || die "--repo needs a URL"; PD_REPO_URL=$2; shift ;;
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; PD_REPO_REF=$2; shift ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a path"; PD_SRC_DIR=$2; shift ;;
    --port) [ $# -ge 2 ] || die "--port needs a number"; PD_WEB_PORT=$2; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown flag: $1 (see --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# OS gate.
# ---------------------------------------------------------------------------
detect_os
case "$DETECTED_OS" in
  unknown) die "unsupported OS ($(uname -s)) — pideck supports macOS and Linux" ;;
esac
detect_arch

printf '\n'
info "PiDeck installer (OS: $DETECTED_OS, arch: $PD_ARCH${PD_DRY_RUN:+, dry-run})"
info "installing into $PD_HOME (source, private node if needed, logs, config)"
printf '\n'

run_fatal mkdir -p "$PD_HOME" "$PD_HOME/bin" "$PD_HOME/lib" "$PD_HOME/log" "$PD_HOME/state" "$PD_HOME/opt"

# --- dependencies ---------------------------------------------------------
ensure_local_bin_path
ensure_git
ensure_node
ensure_pnpm
ensure_gh

# --- source ---------------------------------------------------------------
resolve_source

# --- CLI + config/state (before the build: a failed build leaves a
# --- recoverable CLI — pideck service status / pideck update recover) ------
step "installing pideck CLI and daemon launcher"
install_shell_layer "$PD_HOME/lib"
ensure_local_bin_path
ok "CLI installed: pideck (service control + daemon CLI forwarder)"

step "writing config/state to $PD_HOME"
if [ "$PD_DRY_RUN" != "1" ]; then
  {
    printf '# Generated by the pideck installer — sourced by the service wrapper and CLI.\n'
    printf 'PD_HOME="%s"\n' "$PD_HOME"
    printf 'PD_SRC="%s"\n' "$PD_SRC"
    printf 'PD_NODE="%s"\n' "$PD_NODE_BIN"
    printf 'PD_WEB_PORT="%s"\n' "$PD_WEB_PORT"
    printf '# PIDECK_MODEL is set by onboarding (pideck onboard).\n'
  } > "$PD_HOME/env"
  {
    printf '{\n'
    printf '  "installedAt": "%s",\n' "$(iso_now)"
    printf '  "home": "%s",\n' "$(json_str "$PD_HOME")"
    printf '  "src": "%s",\n' "$(json_str "$PD_SRC")"
    printf '  "node": "%s",\n' "$(json_str "$PD_NODE_BIN")"
    printf '  "port": %s,\n' "$PD_WEB_PORT"
    printf '  "os": "%s",\n' "$DETECTED_OS"
    printf '  "repoUrl": "%s",\n' "$(json_str "$PD_REPO_URL")"
    printf '  "repoRef": "%s"\n' "$(json_str "$PD_REPO_REF")"
    printf '}\n'
  } > "$PD_HOME/config.json"
  ok "wrote $PD_HOME/env and $PD_HOME/config.json"
else
  printf '[dry-run] write %s/env and %s/config.json\n' "$PD_HOME" "$PD_HOME"
fi

# --- build -----------------------------------------------------------------
build_from_source

# --- pi coding agent ------------------------------------------------------
install_pi_agent

# --- pideck pi skills -----------------------------------------------------
install_skills

# --- persistent service ---------------------------------------------------
register_service

# --- guided onboarding ----------------------------------------------------
if [ "$PD_NO_ONBOARD" = "1" ]; then
  info "skipping onboarding (--no-onboard)"
  info "NEXT STEP: run  pideck onboard  to set up pi/gh auth and the review account"
else
  info "starting guided onboarding (pi auth + model, gh auth, review account)"
  info "if no pi credentials are found, pi opens for /login automatically"
  run sh "$PD_HOME/lib/onboard.sh"
fi

# Onboarding can legitimately end incomplete (skipped flags, non-interactive
# runs, an aborted /login, a missing review account). Never let that pass
# silently — the loop cannot run until onboarding is complete.
if [ -f "$PD_HOME/onboarding.json" ] && grep -q '"status": "none"' "$PD_HOME/onboarding.json"; then
  printf '\n'
  warn "onboarding incomplete — re-run 'pideck onboard' to finish"
  printf '\n'
fi

# --- summary --------------------------------------------------------------
printf '\n'
info "PiDeck installed"
printf '\n'
info "webapp: $(webapp_url)  (once the daemon serves it)"
info "service: pideck service start|stop|status  /  logs: pideck logs"
info "agent CLI (status/project/sessions/workers/send): forwarded to the daemon — see 'pideck help'"
info "onboarding: pideck onboard   uninstall: sh $PD_SRC/install/uninstall.sh"
printf '\n'
