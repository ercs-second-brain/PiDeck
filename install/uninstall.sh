#!/bin/sh
# shellcheck shell=sh disable=SC1091
#
# agentsKISS uninstaller.
#
#   install/uninstall.sh [--purge] [-y]
#
# Default: stop + remove the service, remove ~/.agentskiss/bin|lib and the
# CLI symlink, and remove the agentskiss skill symlinks from ~/.pi/agent.
#   --purge  also remove ~/.agentskiss entirely (source, node, logs, config)
#   -y       assume yes

set -u
SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$SCRIPT_DIR/lib/common.sh"
. "$SCRIPT_DIR/lib/service.sh"

PURGE=0
ASSUME_YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1 ;;
    -y | --yes) ASSUME_YES=1; AK_NONINTERACTIVE=1 ;;
    -h | --help) printf 'Usage: uninstall.sh [--purge] [-y]\n'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

detect_os
detect_arch

info "uninstalling agentsKISS"

# Load install config (node paths, src, port) if present.
AK_SRC=""
AK_NODE_BIN_DIR=""
if [ -f "$AK_HOME/env" ]; then
  # shellcheck disable=SC1090
  . "$AK_HOME/env"
  [ -n "${AGENTSKISS_SRC:-}" ] && AK_SRC=$AGENTSKISS_SRC
  [ -n "${AGENTSKISS_NODE:-}" ] && AK_NODE_BIN_DIR=$(dirname "$AGENTSKISS_NODE")
fi

confirm() {
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  ask_yn "$1" n || die "aborted"
}

# --- service ---------------------------------------------------------------
step "removing persistent service"
case "$DETECTED_OS" in
  darwin)
    _plist="$HOME/Library/LaunchAgents/$AK_SERVICE_LABEL.plist"
    run_ignore launchctl bootout "gui/$(id -u)" "$_plist"
    run_ignore launchctl unload "$_plist"
    run rm -f "$_plist"
    ok "launchd agent removed"
    ;;
  linux | wsl)
    if systemctl --user is-system-running >/dev/null 2>&1; then
      run_ignore systemctl --user disable --now agentskiss.service
    fi
    run rm -f "$HOME/.config/systemd/user/agentskiss.service"
    run_ignore systemctl --user daemon-reload
    ok "systemd unit removed"
    ;;
esac

# --- CLI + launcher --------------------------------------------------------
step "removing CLI and launcher"
confirm "Remove agentskiss CLI and daemon launcher?" &&
  {
    run rm -f "$AK_HOME/bin/agentskiss" "$AK_HOME/bin/agentskiss-daemon"
    run rm -f "$AK_LOCAL_BIN/agentskiss"
    ok "CLI removed (node/pnpm/gh/pi are left in place)"
  }

# --- pi asset symlinks -----------------------------------------------------
step "removing agentskiss skill symlinks from ~/.pi/agent"
if [ -n "$AK_SRC" ]; then
  for _kind in skills extensions commands prompt-templates themes; do
    _dir="$AK_PI_DIR/$_kind"
    [ -d "$_dir" ] || continue
    for _entry in "$_dir"/*; do
      [ -L "$_entry" ] || continue
      _link_target=$(readlink "$_entry")
      case "$_link_target" in
        "$AK_SRC"/agent/*) run rm -f "$_entry" ;;
      esac
    done
  done
  ok "pi symlinks pointing into the agentskiss source removed"
else
  info "no source dir recorded; skipping pi symlink cleanup"
fi

# --- home ------------------------------------------------------------------
if [ "$PURGE" = "1" ]; then
  confirm "Purge ALL of $AK_HOME (source, node, logs, config)?" &&
    {
      run rm -rf "$AK_HOME"
      ok "removed $AK_HOME"
    }
else
  info "kept $AK_HOME (config, logs, source). Use --purge to remove it entirely."
fi

info "agentsKISS uninstalled"
