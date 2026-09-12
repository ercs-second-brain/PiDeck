#!/bin/sh
# shellcheck shell=sh disable=SC1091
#
# PiDeck uninstaller.
#
#   install/uninstall.sh [--purge] [-y]
#
# Default: stop + remove the service, remove ~/.pideck/bin|lib and the CLI
# symlink, and remove the pideck skill symlinks from ~/.pi/agent/skills.
#   --purge  also remove ~/.pideck entirely (source, node, logs, config)
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
    -y | --yes) ASSUME_YES=1; export PD_NONINTERACTIVE=1 ;;
    -h | --help) printf 'Usage: uninstall.sh [--purge] [-y]\n'; exit 0 ;;
    *) die "unknown option: $1" ;;
  esac
  shift
done

detect_os
detect_arch

info "uninstalling PiDeck"

# Load install config (src, for the pi skill symlinks below) if present.
PD_SRC=""
if [ -f "$PD_HOME/env" ]; then
  # shellcheck disable=SC1090
  . "$PD_HOME/env"
fi

confirm() {
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  ask_yn "$1" n || die "aborted"
}

# --- service ---------------------------------------------------------------
step "removing persistent service"
case "$DETECTED_OS" in
  darwin)
    _plist="$HOME/Library/LaunchAgents/$PD_SERVICE_LABEL.plist"
    run_ignore launchctl bootout "gui/$(id -u)" "$_plist"
    run_ignore launchctl unload "$_plist"
    run rm -f "$_plist"
    ok "launchd agent removed"
    ;;
  linux)
    if systemctl --user is-system-running >/dev/null 2>&1; then
      run_ignore systemctl --user disable --now "$PD_SERVICE_NAME"
    fi
    run rm -f "$HOME/.config/systemd/user/$PD_SERVICE_NAME"
    run_ignore systemctl --user daemon-reload
    ok "systemd unit removed"
    ;;
esac

# --- CLI + launcher --------------------------------------------------------
step "removing CLI and launcher"
confirm "Remove pideck CLI and daemon launcher?" &&
  {
    run rm -f "$PD_HOME/bin/pideck" "$PD_HOME/bin/pideck-daemon"
    run rm -f "$PD_LOCAL_BIN/pideck"
    ok "CLI removed (node/pnpm/gh/pi are left in place)"
  }

# --- pi skill symlinks -----------------------------------------------------
step "removing pideck skill symlinks from ~/.pi/agent/skills"
if [ -n "$PD_SRC" ] && [ -d "$PD_PI_DIR/skills" ]; then
  for _entry in "$PD_PI_DIR/skills/"*; do
    [ -L "$_entry" ] || continue
    _link_target=$(readlink "$_entry")
    case "$_link_target" in
      "$PD_SRC"/agent/*) run rm -f "$_entry" ;;
    esac
  done
  ok "pi skill symlinks pointing into the pideck source removed"
else
  info "no source dir recorded; skipping pi symlink cleanup"
fi

# --- home ------------------------------------------------------------------
if [ "$PURGE" = "1" ]; then
  confirm "Purge ALL of $PD_HOME (source, node, logs, config, settings)?" &&
    {
      run rm -rf "$PD_HOME"
      ok "removed $PD_HOME"
    }
else
  info "kept $PD_HOME (config, logs, source, settings). Use --purge to remove it entirely."
fi

info "PiDeck uninstalled"
