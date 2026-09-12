# shellcheck shell=sh
#
# Service registration + control for the pideck daemon/webapp.
#
#   macOS: launchd LaunchAgent
#     ~/Library/LaunchAgents/com.pideck.daemon.plist   (RunAtLoad + KeepAlive)
#   Linux: systemd *user* service
#     ~/.config/systemd/user/pideck-daemon.service     (Restart=on-failure,
#                                                       WantedBy=default.target)
#
# Both units start at login and exec $PD_HOME/bin/pideck-daemon, which
# sources $PD_HOME/env and launches the built daemon entrypoint from $PD_SRC.

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
    linux) _register_systemd ;;
    *) warn "no service registration for OS '$DETECTED_OS'"; return 0 ;;
  esac
}

_register_launchd() {
  _la_target="$HOME/Library/LaunchAgents/$PD_SERVICE_LABEL.plist"
  run mkdir -p "$HOME/Library/LaunchAgents" "$PD_HOME/log"
  _render_file "$PD_SRC/install/service/$PD_SERVICE_LABEL.plist" "$_la_target"
  if [ "$PD_DRY_RUN" != "1" ] && command -v plutil >/dev/null 2>&1; then
    plutil -lint "$_la_target" || die "generated launchd plist failed lint: $_la_target"
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
      warn "systemd user session is not available"
      warn "unit written to $_sd_target; once systemd is available run:"
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
# Control (used by the pideck CLI and the update apply path)
# ---------------------------------------------------------------------------
svc_start() {
  case "$DETECTED_OS" in
    darwin)
      run launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$PD_SERVICE_LABEL.plist" 2>/dev/null ||
        run launchctl load -w "$HOME/Library/LaunchAgents/$PD_SERVICE_LABEL.plist"
      ;;
    linux) run systemctl --user start "$PD_SERVICE_NAME" ;;
    *) die "unsupported OS" ;;
  esac
}

svc_stop() {
  case "$DETECTED_OS" in
    darwin)
      run launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/$PD_SERVICE_LABEL.plist" 2>/dev/null ||
        run launchctl unload "$HOME/Library/LaunchAgents/$PD_SERVICE_LABEL.plist"
      ;;
    linux) run systemctl --user stop "$PD_SERVICE_NAME" ;;
    *) die "unsupported OS" ;;
  esac
}

_launchd_job_pid() {
  launchctl print "gui/$(id -u)/$PD_SERVICE_LABEL" 2>/dev/null | sed -n 's/^[[:space:]]*pid = //p' | head -n 1
}

_systemd_main_pid() {
  systemctl --user show -p MainPID --value "$PD_SERVICE_NAME" 2>/dev/null
}

# _svc_wait_restart <what> <old-pid> <pid-fn> — poll (up to ~30s) until the
# service's main pid differs from <old-pid>, proving the restart actually
# happened. Dies loudly on timeout.
_svc_wait_restart() {
  _sw_what=$1
  _sw_old=$2
  _sw_fn=$3
  _sw_i=0
  while [ "$_sw_i" -lt 30 ]; do
    _sw_new=$("$_sw_fn")
    if [ -n "$_sw_new" ] && [ "$_sw_new" != "0" ] && [ "$_sw_new" != "$_sw_old" ]; then
      ok "service restarted ($_sw_what: pid ${_sw_old:-?} -> $_sw_new)"
      return 0
    fi
    _sw_i=$((_sw_i + 1))
    sleep 1
  done
  die "service restart did not take ($_sw_what still runs pid ${_sw_old:-unknown} after 30s) — check 'pideck service status'"
}

svc_restart() {
  case "$DETECTED_OS" in
    darwin)
      if ! launchctl print "gui/$(id -u)/$PD_SERVICE_LABEL" >/dev/null 2>&1; then
        die "service not loaded ($PD_SERVICE_LABEL) — run 'pideck service start' first"
      fi
      _sr_old=$(_launchd_job_pid)
      if ! run launchctl kickstart -k "gui/$(id -u)/$PD_SERVICE_LABEL"; then
        die "launchctl kickstart -k $PD_SERVICE_LABEL failed — check 'pideck service status'"
      fi
      _svc_wait_restart "launchd $PD_SERVICE_LABEL" "$_sr_old" _launchd_job_pid
      ;;
    linux)
      if ! command -v systemctl >/dev/null 2>&1; then
        die "systemctl not found — this machine has no systemd user session"
      fi
      if ! systemctl --user is-active --quiet "$PD_SERVICE_NAME" 2>/dev/null; then
        die "service $PD_SERVICE_NAME is not active — run 'pideck service start' first"
      fi
      _sr_old=$(_systemd_main_pid)
      # KillMode=process (unit template): a restart kills only the daemon's
      # main process — the tmux/agent sessions it spawned survive it.
      if ! run systemctl --user restart "$PD_SERVICE_NAME"; then
        die "systemctl --user restart $PD_SERVICE_NAME failed — check 'journalctl --user -u $PD_SERVICE_NAME'"
      fi
      _svc_wait_restart "systemd $PD_SERVICE_NAME" "$_sr_old" _systemd_main_pid
      ;;
    *) die "unsupported OS" ;;
  esac
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
    linux) systemctl --user status "$PD_SERVICE_NAME" --no-pager ;;
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
    linux)
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
