# shellcheck shell=sh
#
# Installs the pideck pi skills/extensions from <monorepo>/agent/ into
# the pi agent directory (~/.pi/agent/), plus the pi coding agent itself
# as an npm-global package under the active Node (issue #202).
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

# install_pi_agent — npm-install pi's package under the ACTIVE node.
#
# The active node is the private runtime ($PD_NODE) when this install has
# one, else whatever `node` is on PATH (issue #202: node and pi must move
# together — an apply that refreshes the private runtime but leaves pi
# installed under the old node restarts into crashes like pi 0.75+'s
# `zlib.createZstdDecompress is not a function` on Node < 22.19).
#
# Engines check (issue #202): pi's package.json requires Node >=
# $PD_NODE_MIN_VERSION; installing under anything older would ship a
# broken agent, so this dies instead. Installs into the shared private
# npm prefix ($PD_HOME/opt/npm-global) and re-points the ~/.local/bin
# symlinks — the same steps as bootstrap.sh, kept here so the update path
# reuses them verbatim.
install_pi_agent() {
  _pa_node="${PD_NODE:-}"
  [ -x "$_pa_node" ] || _pa_node=$(command -v node 2>/dev/null) || die "no node found — run the pideck installer first"
  _pa_node_dir=$(dirname "$_pa_node")
  _pa_ver=$("$_pa_node" -v 2>/dev/null) || die "node at $_pa_node does not run — cannot install pi"
  if ! _node_version_ge "${_pa_ver#v}" "$PD_NODE_MIN_VERSION"; then
    die "pi needs Node >= $PD_NODE_MIN_VERSION but the active node is $_pa_ver — run 'pideck update' (it refreshes the private runtime and reinstalls pi together)"
  fi
  step "installing pi coding agent (under node $_pa_ver at $_pa_node)"
  run env NPM_CONFIG_PREFIX="$PD_HOME/opt/npm-global" "$_pa_node_dir/npm" install -g --ignore-scripts "$PD_PI_NPM_PACKAGE"
  for _pi_bin in "$PD_HOME/opt/npm-global/bin/"*; do
    [ -e "$_pi_bin" ] || continue
    run ln -sfn "$_pi_bin" "$PD_LOCAL_BIN/$(basename "$_pi_bin")"
  done
  ensure_local_bin_path
  command -v pi >/dev/null 2>&1 || die "pi installation failed"
  ok "installed pi $(pi --version 2>/dev/null | head -n 1)"
}

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
