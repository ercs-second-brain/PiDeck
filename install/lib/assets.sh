# shellcheck shell=sh
#
# Installs the pideck pi skills/extensions from <monorepo>/agent/ into
# the pi agent directory (~/.pi/agent/).
#
# The skills/extensions themselves are delivered by a separate issue; this
# step is written so that whatever shows up in agent/ at install time gets
# picked up without further changes here:
#
#   agent/skills/<name>/…            -> ~/.pi/agent/skills/<name>
#   agent/extensions/<name>(.mjs)    -> ~/.pi/agent/extensions/<name>
#   agent/commands/<name>            -> ~/.pi/agent/commands/<name>
#   agent/prompt-templates/<name>    -> ~/.pi/agent/prompt-templates/<name>
#   agent/themes/<name>              -> ~/.pi/agent/themes/<name>
#
# Everything is symlinked (not copied), so a `git pull` in $PD_SRC followed
# by re-running the installer (or just the asset step) updates pi in place.

install_agent_assets() {
  step "installing pideck pi skills/extensions from agent/"
  if [ ! -d "$PD_SRC/agent" ]; then
    warn "no agent/ directory in $PD_SRC; skipping pi asset install"
    return 0
  fi

  _ia_linked=0
  _ia_kinds="skills extensions commands prompt-templates themes"
  for _ia_kind in $_ia_kinds; do
    _ia_srcdir="$PD_SRC/agent/$_ia_kind"
    [ -d "$_ia_srcdir" ] || continue
    run mkdir -p "$PD_PI_DIR/$_ia_kind"
    for _ia_entry in "$_ia_srcdir"/*; do
      [ -e "$_ia_entry" ] || continue
      _ia_name=$(basename "$_ia_entry")
      _ia_target="$PD_PI_DIR/$_ia_kind/$_ia_name"
      run ln -sfn "$_ia_entry" "$_ia_target"
      ok "linked agent/$_ia_kind/$_ia_name -> $_ia_target"
      _ia_linked=$((_ia_linked + 1))
    done
  done

  if [ "$_ia_linked" -eq 0 ]; then
    info "no skills/extensions published in agent/ yet (separate issue); nothing to link — the daemon install continues"
  else
    ok "linked $_ia_linked pi asset(s) into $PD_PI_DIR"
  fi
}
