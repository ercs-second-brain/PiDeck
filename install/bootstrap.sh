#!/bin/sh
# shellcheck shell=sh disable=SC1091
#
# agentsKISS one-line installer entrypoint.
#
#   curl -fsSL https://raw.githubusercontent.com/ercs-second-brain/agentsKISS/main/install/bootstrap.sh | sh
#
# Works when piped (curl | sh) and when run from a checkout. Flow:
#   1. detect OS (macOS / Linux / WSL; Windows hosts are routed to the WSL
#      bootstrap in windows/agentskiss-setup.ps1)
#   2. install git, Node 22, pnpm, gh (user-level, no sudo on the main path)
#   3. fetch the monorepo source and build daemon + webapp
#   4. install the pi coding agent
#   5. link the agentskiss pi skills/extensions from agent/ (whatever exists
#      there at install time)
#   6. write config/state to ~/.agentskiss/ (read by the daemon later)
#   7. register the persistent service (launchd / systemd; WSL uses systemd)
#   8. run guided onboarding (pi auth + model, gh auth) unless --no-onboard
#
# Flags:
#   --dry-run       print mutating commands instead of running them
#   --no-onboard    skip the interactive onboarding step
#   --repo URL      monorepo git URL (default: ercs-second-brain/agentsKISS)
#   --ref REF       branch/tag to install (default: main)
#   --dir PATH      use an existing checkout instead of cloning
#   --port N        webapp port (default: 8321)
#   -h, --help

set -u

usage() { sed -n '3,25p' "$0" | sed 's/^# \{0,1\}//'; }

# ---------------------------------------------------------------------------
# `curl | sh` handling (must run before flag parsing so "$@" survives the
# re-exec): stdin is the pipe, so interactive prompts would eat the script.
# Unpack the repo tarball, then re-exec this same script from disk with tty
# stdin restored and the original flags forwarded.
# ---------------------------------------------------------------------------
if [ ! -t 0 ] && [ "${AK_BOOTSTRAP_REEXEC:-0}" != "1" ]; then
  _pb_repo="${AGENTSKISS_REPO_URL:-https://github.com/ercs-second-brain/agentsKISS.git}"
  _pb_ref="${AGENTSKISS_REPO_REF:-main}"
  _pb_tmp="${AGENTSKISS_HOME:-$HOME/.agentskiss}/opt/.bootstrap-tmp"
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
    printf 'error: could not fetch the agentskiss source (%s)\n' "$_pb_repo" >&2
    exit 1
  fi
  AK_BOOTSTRAP_REEXEC=1
  export AK_BOOTSTRAP_REEXEC
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

AK_SRC_DIR=""
AK_NO_ONBOARD=0
# AK_SRC_DIR is consumed by resolve_source() from lib/source.sh.
# shellcheck disable=SC2034
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) AK_DRY_RUN=1 ;;
    --no-onboard) AK_NO_ONBOARD=1 ;;
    --repo) [ $# -ge 2 ] || die "--repo needs a URL"; AK_REPO_URL=$2; shift ;;
    --ref) [ $# -ge 2 ] || die "--ref needs a value"; AK_REPO_REF=$2; shift ;;
    --dir) [ $# -ge 2 ] || die "--dir needs a path"; AK_SRC_DIR=$2; shift ;;
    --port) [ $# -ge 2 ] || die "--port needs a number"; AK_WEB_PORT=$2; shift ;;
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
  windows-host)
    die "Windows host shell detected — run install/windows/agentskiss-setup.ps1 in PowerShell instead (it installs WSL and finishes inside it)"
    ;;
  unknown)
    die "unsupported OS ($(uname -s))"
    ;;
esac
detect_arch

printf '\n'
info "agentsKISS installer (OS: $DETECTED_OS, arch: $AK_ARCH${AK_DRY_RUN:+, dry-run})"
info "installing into $AK_HOME (source, private node if needed, logs, config)"
printf '\n'

run mkdir -p "$AK_HOME" "$AK_HOME/bin" "$AK_HOME/lib" "$AK_HOME/log" "$AK_HOME/state" "$AK_HOME/opt"

# --- dependencies ---------------------------------------------------------
ensure_local_bin_path
ensure_git
ensure_node
ensure_pnpm
ensure_gh

# --- source + build -------------------------------------------------------
resolve_source
build_from_source

# --- pi coding agent ------------------------------------------------------
step "installing pi coding agent"
if command -v pi >/dev/null 2>&1; then
  ok "pi already installed ($(pi --version 2>/dev/null | head -n 1) at $(command -v pi))"
else
  run env NPM_CONFIG_PREFIX="$AK_HOME/opt/npm-global" "$AK_NODE_BIN_DIR/npm" install -g --ignore-scripts "$AK_PI_NPM_PACKAGE"
  for _pi_bin in "$AK_HOME/opt/npm-global/bin/"*; do
    [ -e "$_pi_bin" ] || continue
    run ln -sfn "$_pi_bin" "$AK_LOCAL_BIN/$(basename "$_pi_bin")"
  done
  ensure_local_bin_path
  command -v pi >/dev/null 2>&1 || die "pi installation failed"
  ok "installed pi $(pi --version 2>/dev/null | head -n 1)"
fi

# --- agentskiss pi skills/extensions (whatever exists in agent/) ----------
install_agent_assets

# --- CLI + service launcher ----------------------------------------------
step "installing agentskiss CLI and daemon launcher"
for _cli_file in "$AK_SRC/install/bin/"*; do
  [ -f "$_cli_file" ] || continue
  run cp "$_cli_file" "$AK_HOME/bin/$(basename "$_cli_file")"
  run chmod +x "$AK_HOME/bin/$(basename "$_cli_file")"
done
for _lib_file in "$AK_SRC/install/lib/"*.sh "$AK_SRC/install/onboard.sh"; do
  [ -f "$_lib_file" ] || continue
  run cp "$_lib_file" "$AK_HOME/lib/$(basename "$_lib_file")"
done
run ln -sfn "$AK_HOME/bin/agentskiss" "$AK_LOCAL_BIN/agentskiss"
ensure_local_bin_path
ok "CLI installed: agentskiss (start|stop|status|addr|onboard|logs)"

# --- config/state: ~/.agentskiss (read by the daemon later) ---------------
step "writing config/state to $AK_HOME"
if [ "$AK_DRY_RUN" != "1" ]; then
  {
    printf '# Generated by the agentskiss installer — sourced by the service wrapper and CLI.\n'
    printf 'AGENTSKISS_HOME="%s"\n' "$AK_HOME"
    printf 'AGENTSKISS_SRC="%s"\n' "$AK_SRC"
    printf 'AGENTSKISS_NODE="%s"\n' "$AK_NODE_BIN"
    printf 'AGENTSKISS_WEB_PORT="%s"\n' "$AK_WEB_PORT"
    printf '# AGENTSKISS_MODEL is set by onboarding (agentskiss onboard).\n'
  } > "$AK_HOME/env"
  {
    printf '{\n'
    printf '  "installedAt": "%s",\n' "$(iso_now)"
    printf '  "home": "%s",\n' "$(json_str "$AK_HOME")"
    printf '  "src": "%s",\n' "$(json_str "$AK_SRC")"
    printf '  "node": "%s",\n' "$(json_str "$AK_NODE_BIN")"
    printf '  "port": %s,\n' "$AK_WEB_PORT"
    printf '  "os": "%s",\n' "$DETECTED_OS"
    printf '  "repoUrl": "%s",\n' "$(json_str "$AK_REPO_URL")"
    printf '  "repoRef": "%s"\n' "$(json_str "$AK_REPO_REF")"
    printf '}\n'
  } > "$AK_HOME/config.json"
  ok "wrote $AK_HOME/env and $AK_HOME/config.json"
else
  printf '[dry-run] write %s/env and %s/config.json\n' "$AK_HOME" "$AK_HOME"
fi

# --- persistent service ---------------------------------------------------
register_service

# --- guided onboarding ----------------------------------------------------
if [ "$AK_NO_ONBOARD" = "1" ]; then
  info "skipping onboarding (--no-onboard); run 'agentskiss onboard' later"
else
  info "starting guided onboarding (pi auth + model selection, gh auth)"
  run sh "$AK_HOME/lib/onboard.sh"
fi

# --- summary --------------------------------------------------------------
printf '\n'
info "agentsKISS installed"
if [ "$AK_DRY_RUN" != "1" ] && grep -q 'placeholder' "$AK_SRC/apps/daemon/src/index.ts" 2>/dev/null; then
  warn "the current daemon build is a placeholder (main() exits immediately) — the service unit is registered and will run the real daemon once it lands"
fi
printf '\n'
info "webapp: $(webapp_url)  (once the daemon serves it)"
info "service: agentskiss start|stop|status  /  logs: agentskiss logs"
info "onboarding: agentskiss onboard   uninstall: sh $AK_SRC/install/uninstall.sh"
printf '\n'
