# shellcheck shell=sh
#
# Installs the pideck pi skills from <monorepo>/agent/skills/ into the pi
# agent directory (~/.pi/agent/skills/). Pi loads them like any other skill;
# pideck has no skill plumbing of its own.
#
# Everything is symlinked (not copied), so a `git pull` in $PD_SRC followed
# by re-running the asset step updates pi in place. Stale links owned by
# this install (target under $PD_SRC/agent) are pruned; user-owned entries
# are never touched.

install_skills() {
  step "installing pideck pi skills from agent/skills"
  if [ ! -d "$PD_SRC/agent/skills" ]; then
    warn "no agent/skills directory in $PD_SRC; skipping skill install"
    return 0
  fi

  run mkdir -p "$PD_PI_DIR/skills"
  _is_linked=0
  for _is_entry in "$PD_SRC/agent/skills/"*; do
    [ -e "$_is_entry" ] || continue
    _is_name=$(basename "$_is_entry")
    run ln -sfn "$_is_entry" "$PD_PI_DIR/skills/$_is_name"
    _is_linked=$((_is_linked + 1))
  done
  ok "linked $_is_linked skill(s) into $PD_PI_DIR/skills"

  for _is_entry in "$PD_PI_DIR/skills/"*; do
    [ -L "$_is_entry" ] || continue
    _is_target=$(readlink "$_is_entry") || continue
    case "$_is_target" in
      "$PD_SRC"/agent/*) ;;
      *) continue ;;
    esac
    [ -e "$_is_target" ] && continue
    run rm "$_is_entry"
    ok "pruned stale link $(basename "$_is_entry") (target removed: $_is_target)"
  done
}
