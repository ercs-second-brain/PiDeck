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
  run env NPM_CONFIG_PREFIX="$PD_HOME/opt/npm-global" "$_pa_node_dir/npm" install -g --ignore-scripts "$PD_PI_PACKAGE"
  for _pi_bin in "$PD_HOME/opt/npm-global/bin/"*; do
    [ -e "$_pi_bin" ] || continue
    # A shim in $PD_HOME/bin owns the ~/.local/bin name (issue #252: the pi
    # shim pins the canonical node — a direct npm-global symlink would let
    # the `#!/usr/bin/env node` shebang resolve a system node instead).
    # install_shell_layer maintains that entry; never clobber it here.
    [ -e "$PD_HOME/bin/$(basename "$_pi_bin")" ] && continue
    run ln -sfn "$_pi_bin" "$PD_LOCAL_BIN/$(basename "$_pi_bin")"
  done
  ensure_local_bin_path
  command -v pi >/dev/null 2>&1 || die "pi installation failed"
  ok "installed pi $(pi --version 2>/dev/null | head -n 1)"
}

# pi_installed_version — the version of the pi binary on PATH. Fails (empty,
# nonzero) when pi is missing or its output carries no x.y.z; `pi --version`
# may decorate the number, so the first version-like token of the first line
# wins.
pi_installed_version() {
  command -v pi >/dev/null 2>&1 || return 1
  pi --version 2>/dev/null | head -n 1 | sed -n 's/.*\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*/\1/p'
}

# pi_npm_latest — the newest published version of $PD_PI_PACKAGE on npm,
# read with the ACTIVE node's npm (the same binary the reinstall would use).
# Fails (empty, nonzero) when npm or the registry is unavailable — callers
# skip the refresh then, never block the update on it.
pi_npm_latest() {
  _pnl_node="${PD_NODE:-}"
  [ -x "$_pnl_node" ] || _pnl_node=$(command -v node 2>/dev/null) || return 1
  _pnl_npm="$(dirname "$_pnl_node")/npm"
  [ -x "$_pnl_npm" ] || return 1
  "$_pnl_npm" view "$PD_PI_PACKAGE" version 2>/dev/null | tail -n 1 | tr -d '[:space:]'
}

# refresh_pi_agent — reinstall pi only when npm has a newer version (issue
# #223): an install can sit on a stale pi for weeks otherwise, because pi has
# no self-update channel the apply could lean on. Runs on EVERY apply, after
# refresh_node_runtime (the active node is already the refreshed one then).
# $PD_PI_PACKAGE is unpinned, so the install resolves npm's `latest` tag.
# Returns 1 when it (re)installed pi — callers treat that as "the agent
# moved, restart the daemon" — and 0 when pi is already current (or the
# latest version could not be read: never a dead end, just a skipped step).
refresh_pi_agent() {
  _rpi_installed=$(pi_installed_version) || _rpi_installed=
  _rpi_latest=$(pi_npm_latest) || _rpi_latest=
  if [ -z "$_rpi_latest" ]; then
    warn "cannot read the latest pi version from npm — leaving pi at ${_rpi_installed:-unknown}"
    return 0
  fi
  if [ -z "$_rpi_installed" ]; then
    install_pi_agent # pi missing entirely — install under the active node
    return 1
  fi
  if _node_version_ge "$_rpi_installed" "$_rpi_latest"; then
    ok "pi is current ($_rpi_installed; npm latest $_rpi_latest)"
    return 0
  fi
  step "updating pi ($_rpi_installed -> $_rpi_latest)"
  install_pi_agent
  return 1
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
