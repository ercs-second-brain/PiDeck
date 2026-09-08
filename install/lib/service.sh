# shellcheck shell=sh
#
# Service registration + control for the pideck daemon/webapp.
#
#   macOS (incl. Macs under WSL? no — darwin native): launchd LaunchAgent
#     ~/Library/LaunchAgents/com.pideck.daemon.plist
#   Linux + WSL2 (with systemd enabled): systemd *user* service
#     ~/.config/systemd/user/pideck-daemon.service
#
# Both units exec $PD_HOME/bin/pideck-daemon, which sources
# $PD_HOME/env and launches the built daemon entrypoint from $PD_SRC.
#
# WSL note: the Linux/systemd path IS the WSL path. The Windows bootstrap
# (windows/pideck-setup.ps1) installs WSL if needed, enables systemd in
# the distro, then runs this installer inside it.

PD_SERVICE_LABEL="com.pideck.daemon"
PD_SERVICE_NAME="pideck-daemon.service"

# PATH for the service context (daemon spawns tmux, git, gh, pi, …).
_serve_path() {
  printf '%s' "$PD_NODE_BIN_DIR:$PD_LOCAL_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

# Render a template (placeholders @PD_…@) to a target file.
_render_file() { # _render_file <template> <target>
  _rf_tpl=$1
  _rf_target=$2
  if [ ! -f "$_rf_tpl" ]; then
    # In dry-run mode the source may never have been fetched.
    if [ "$PD_DRY_RUN" = "1" ]; then
      printf "[dry-run] render %s -> %s\n" "$_rf_tpl" "$_rf_target"
      return 0
    fi
    die "service template missing: $_rf_tpl"
  fi
  if [ "$PD_DRY_RUN" = "1" ]; then
    printf "[dry-run] render %s -> %s\n" "$_rf_tpl" "$_rf_target"
    return 0
  fi
  sed -e "s|@PD_HOME@|$PD_HOME|g" \
    -e "s|@PD_SRC@|$PD_SRC|g" \
    -e "s|@PD_NODE@|$PD_NODE_BIN|g" \
    -e "s|@PD_PORT@|$PD_WEB_PORT|g" \
    -e "s|@PD_SERVE_PATH@|$(_serve_path)|g" \
    "$_rf_tpl" > "$_rf_target"
}

# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------
register_service() {
  step "registering persistent service"
  case "$DETECTED_OS" in
    darwin) _register_launchd ;;
    linux | wsl) _register_systemd ;;
    *) warn "no service registration for OS '$DETECTED_OS'"; return 0 ;;
  esac
}

_register_launchd() {
  _la_target="$HOME/Library/LaunchAgents/$PD_SERVICE_LABEL.plist"
  run mkdir -p "$HOME/Library/LaunchAgents" "$PD_HOME/log"
  _render_file "$PD_SRC/install/service/$PD_SERVICE_LABEL.plist" "$_la_target"
  if command -v plutil >/dev/null 2>&1; then
    if [ "$PD_DRY_RUN" != "1" ]; then
      plutil -lint "$_la_target" || die "generated launchd plist failed lint: $_la_target"
    fi
  fi
  if [ "$PD_DRY_RUN" = "1" ]; then
    printf "[dry-run] launchctl bootout gui/$(id -u) %s (ignore errors)\n" "$_la_target"
    printf "[dry-run] launchctl bootstrap gui/$(id -u) %s\n" "$_la_target"
  else
    launchctl bootout "gui/$(id -u)" "$_la_target" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$_la_target" >/dev/null 2>&1 ||
      launchctl load -w "$_la_target" ||
      die "launchctl failed to load $_la_target"
  fi
  ok "launchd agent installed at $_la_target (RunAtLoad + KeepAlive on crash)"
}

_register_systemd() {
  _sd_dir="$HOME/.config/systemd/user"
  _sd_target="$_sd_dir/$PD_SERVICE_NAME"
  run mkdir -p "$_sd_dir" "$PD_HOME/log"
  _render_file "$PD_SRC/install/service/$PD_SERVICE_NAME" "$_sd_target"

  if ! systemctl --user is-system-running >/dev/null 2>&1; then
    _sd_rc=0
    systemctl --user is-system-running >/dev/null 2>&1 || _sd_rc=$?
    # 0 = running, 1 = degraded (still usable); anything else = no user systemd.
    if [ "$_sd_rc" -le 1 ]; then
      :
    else
      warn "systemd user session is not available (WSL without systemd, or no systemd)"
      warn "unit written to $_sd_target; enable systemd (see install/README.md, WSL section) then run:"
      warn "  systemctl --user daemon-reload && systemctl --user enable --now $PD_SERVICE_NAME"
      return 0
    fi
  fi

  run systemctl --user daemon-reload
  run systemctl --user enable --now "$PD_SERVICE_NAME"
  # Linger lets the user service run without an active login session.
  run_ignore loginctl enable-linger "$(id -un)"
  ok "systemd user service enabled: $PD_SERVICE_NAME"
}

# ---------------------------------------------------------------------------
# Control (used by the pideck CLI)
# ---------------------------------------------------------------------------
svc_start() {
  case "$DETECTED_OS" in
    darwin)
      run launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$PD_SERVICE_LABEL.plist" 2>/dev/null ||
        run launchctl load -w "$HOME/Library/LaunchAgents/$PD_SERVICE_LABEL.plist"
      ;;
    linux | wsl) run systemctl --user start "$PD_SERVICE_NAME" ;;
    *) die "unsupported OS" ;;
  esac
}

svc_stop() {
  case "$DETECTED_OS" in
    darwin)
      run launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/$PD_SERVICE_LABEL.plist" 2>/dev/null ||
        run launchctl unload "$HOME/Library/LaunchAgents/$PD_SERVICE_LABEL.plist"
      ;;
    linux | wsl) run systemctl --user stop "$PD_SERVICE_NAME" ;;
    *) die "unsupported OS" ;;
  esac
}

svc_restart() {
  svc_stop
  svc_start
}

svc_status() {
  case "$DETECTED_OS" in
    darwin)
      if launchctl print "gui/$(id -u)/$PD_SERVICE_LABEL" >/dev/null 2>&1; then
        launchctl print "gui/$(id -u)/$PD_SERVICE_LABEL" | grep -E 'state|pid|last exit' | head -n 5
      else
        warn "service not loaded ($PD_SERVICE_LABEL)"
        return 1
      fi
      ;;
    linux | wsl) systemctl --user status "$PD_SERVICE_NAME" --no-pager ;;
    *) die "unsupported OS" ;;
  esac
}

# ---------------------------------------------------------------------------
# Webapp address
# ---------------------------------------------------------------------------
lan_addr() {
  case "$DETECTED_OS" in
    darwin)
      for _la_i in en0 en1 en2; do
        _la_ip=$(ipconfig getifaddr "$_la_i" 2>/dev/null || :)
        [ -n "$_la_ip" ] && { printf '%s' "$_la_ip"; return 0; }
      done
      ;;
    linux | wsl)
      _la_ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1)
      [ -n "$_la_ip" ] && { printf '%s' "$_la_ip"; return 0; }
      _la_ip=$(hostname -I 2>/dev/null | awk '{print $1}')
      [ -n "$_la_ip" ] && { printf '%s' "$_la_ip"; return 0; }
      ;;
  esac
  printf 'localhost'
}

webapp_url() {
  printf 'http://%s:%s' "$(lan_addr)" "$PD_WEB_PORT"
}

# URL to open in the *Windows host* browser on WSL installs. Under WSL2
# localhost forwarding, http://localhost:<port> on Windows reaches a server
# inside the distro (works for both localhost and 0.0.0.0 binds); use the
# `lan_addr`-based URL only for LAN access from other devices, which also
# needs a Windows firewall rule (see install/README.md, WSL section).
windows_host_url() {
  case "$DETECTED_OS" in
    wsl) printf 'http://localhost:%s' "$PD_WEB_PORT" ;;
    *) return 1 ;;
  esac
}
