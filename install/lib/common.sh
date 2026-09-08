# shellcheck shell=sh
#
# Shared helpers for the pideck installer (POSIX sh, no bashisms).
#
# Sourced by bootstrap.sh, onboard.sh, uninstall.sh and the pideck CLI.
# Never executed directly.

set -u

# ---------------------------------------------------------------------------
# Defaults (overridable via environment or CLI flags).
# Exported: they are consumed by the sibling scripts that source this file
# and by installer-launched children.
# ---------------------------------------------------------------------------
export PD_HOME="${PD_HOME:-${PD_HOME:-$HOME/.pideck}}"
PD_DRY_RUN="${PD_DRY_RUN:-0}"
PD_NONINTERACTIVE="${PD_NONINTERACTIVE:-0}"
export PD_REPO_URL="${PD_REPO_URL:-https://github.com/ercs-second-brain/PiDeck.git}"
export PD_REPO_REF="${PD_REPO_REF:-main}"
export PD_WEB_PORT="${PD_WEB_PORT:-8321}"
export PD_NODE_VERSION="${PD_NODE_VERSION:-22.14.0}"
export PD_GH_VERSION="${PD_GH_VERSION:-2.63.2}"
export PD_PI_NPM_PACKAGE="${PD_PI_PACKAGE:-@earendil-works/pi-coding-agent}"
export PD_PI_DIR="${PD_PI_DIR:-${PD_PI_DIR:-$HOME/.pi/agent}}"
export PD_LOCAL_BIN="$HOME/.local/bin"
# Corepack shims download their package manager on first use; never prompt
# mid-install (covers ensure_pnpm's verification and the build's pnpm calls).
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Set once OS detection ran (detect_os).
DETECTED_OS="unknown" # darwin | linux | wsl | windows-host | unknown

# Pre-rebrand install home (issue #125). Kept as a compat symlink pointing at
# $PD_HOME after migrate_home() runs, so old absolute paths keep resolving.
OLD_HOME="$HOME/.agentskiss"

# ---------------------------------------------------------------------------
# Home-dir migration (issue #125): existing installs live under ~/.agentskiss;
# the rebrand moves the install home to ~/.pideck. On the first run of the new
# tooling (installer, CLI, onboarding, uninstall), when ~/.pideck is absent
# and ~/.agentskiss is a real directory, move it — preserving config.json,
# env, onboarding.json, log/, state/ and everything else — and leave a compat
# symlink ~/.agentskiss -> ~/.pideck so old absolute paths (service units,
# running daemons, user scripts) keep resolving mid-flight. The moved env
# and config.json are rewritten in place: AGENTSKISS_MODEL -> PIDECK_MODEL,
# every other AGENTSKISS_* -> PD_*, and recorded <old-home>/… paths ->
# <new-home>/…. Idempotent: fresh installs and already-migrated installs
# (old home is the compat symlink) are left untouched.
# ---------------------------------------------------------------------------
migrate_home() {
  _mh_old=$OLD_HOME
  _mh_new=$PD_HOME
  # Fresh install (no old home) or already migrated (old home is the compat
  # symlink): nothing to do.
  if [ ! -e "$_mh_old" ] || [ -L "$_mh_old" ]; then
    return 0
  fi
  if [ ! -d "$_mh_old" ]; then
    warn "ignoring unexpected non-directory $_mh_old"
    return 0
  fi
  if [ -e "$_mh_new" ]; then
    warn "both $_mh_new and $_mh_old exist; keeping $_mh_new — not merging automatically (resolve manually, then re-run)"
    return 0
  fi
  if [ "$PD_DRY_RUN" = "1" ]; then
    printf '[dry-run] mv %s %s && ln -sfn %s %s\n' "$_mh_old" "$_mh_new" "$_mh_new" "$_mh_old"
    return 0
  fi
  mv "$_mh_old" "$_mh_new" || die "home migration failed: could not move $_mh_old to $_mh_new"
  ln -sfn "$_mh_new" "$_mh_old" || die "home migration failed: could not create compat symlink $_mh_old"
  # The daemon and CLI read the service env (PD_HOME/PD_SRC/…). Rewrite the
  # pre-rebrand names in place so the moved config stays loadable, and point
  # recorded paths at the new home: AGENTSKISS_MODEL -> PIDECK_MODEL, every
  # other AGENTSKISS_* -> PD_* (the split the rebrand pinned), and any
  # <old-home>/… value prefix -> <new-home>/…. Best effort: a failed rewrite
  # must not fail the install (the compat symlink keeps old values resolving).
  for _mh_file in env config.json; do
    [ -f "$_mh_new/$_mh_file" ] || continue
    if sed -e 's/AGENTSKISS_MODEL/PIDECK_MODEL/g' \
      -e 's/AGENTSKISS_/PD_/g' \
      -e "s|$_mh_old|$_mh_new|g" "$_mh_new/$_mh_file" > "$_mh_new/$_mh_file.tmp" 2>/dev/null; then
      mv "$_mh_new/$_mh_file.tmp" "$_mh_new/$_mh_file" || rm -f "$_mh_new/$_mh_file.tmp"
    else
      rm -f "$_mh_new/$_mh_file.tmp"
      warn "could not rewrite PD_* names in $_mh_new/$_mh_file — re-run the installer"
    fi
  done
  ok "migrated install home $_mh_old -> $_mh_new (compat symlink kept at $_mh_old)"
}

# ---------------------------------------------------------------------------
# Old binary-name compat (issue #125): keep the pre-rebrand `agentskiss` /
# `agentskiss-daemon` names resolving to the renamed binaries — inside the
# home bin dir (service units, user scripts) and in ~/.local/bin (user PATH).
# Idempotent; safe to call from the installer and the update path alike.
# ---------------------------------------------------------------------------
install_bin_compat() {
  run mkdir -p "$PD_LOCAL_BIN"
  run ln -sfn pideck "$PD_HOME/bin/agentskiss"
  run ln -sfn pideck-daemon "$PD_HOME/bin/agentskiss-daemon"
  run ln -sfn "$PD_HOME/bin/pideck" "$PD_LOCAL_BIN/agentskiss"
}

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
_pd_tty() { [ -t 2 ]; }

info() {
  if _pd_tty; then printf '\033[1;34m==>\033[0m %s\n' "$*"; else printf '==> %s\n' "$*"; fi
}
step() {
  if _pd_tty; then printf '\033[1;36m-->\033[0m %s\n' "$*"; else printf '%s\n' "--> $*"; fi
}
warn() {
  if _pd_tty; then printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; else printf 'warning: %s\n' "$*" >&2; fi
}
die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}
ok() { printf '  [ok] %s\n' "$*"; }

# ---------------------------------------------------------------------------
# Dry-run aware command execution.
#
# Convention: every *mutating* command goes through run() (or run_ignore()).
# Read-only inspection commands are called directly.
# ---------------------------------------------------------------------------
run() {
  if [ "$PD_DRY_RUN" = "1" ]; then
    printf '[dry-run]'
    for _arg in "$@"; do printf " '%s'" "$_arg"; done
    printf '\n'
    return 0
  fi
  "$@"
}

# Like run(), but failures are non-fatal (best-effort steps).
run_ignore() {
  if [ "$PD_DRY_RUN" = "1" ]; then
    run "$@"
    return 0
  fi
  "$@" >/dev/null 2>&1 || true
}

# Run a command as root when necessary (root itself, else passwordless sudo).
run_sudo() {
  if [ "$(id -u)" = "0" ]; then
    run "$@"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    run sudo "$@"
  else
    die "root privileges required to run: $* (install it manually and re-run)"
  fi
}

# ---------------------------------------------------------------------------
# Interactive prompts. Always read from the controlling terminal when stdin
# is not a tty (the `curl | sh` case re-execs with tty stdin, but be safe).
# ---------------------------------------------------------------------------
ask() { # ask <prompt> <varname>
  _ask_prompt=$1
  _ask_var=$2
  printf '%s' "$_ask_prompt"
  if [ "$PD_NONINTERACTIVE" = "1" ]; then
    printf '\n'
    eval "$_ask_var="
    return 0
  fi
  if [ -t 0 ]; then
    # shellcheck disable=SC2229 # dynamic read by variable name is intended
    IFS= read -r "$_ask_var" || eval "$_ask_var="
  elif [ -r /dev/tty ]; then
    # shellcheck disable=SC2229 # dynamic read by variable name is intended
    IFS= read -r "$_ask_var" < /dev/tty || eval "$_ask_var="
  else
    printf '\n'
    warn "no terminal available for prompt; continuing with empty answer"
    eval "$_ask_var="
  fi
}

ask_yn() { # ask_yn <prompt> <default: y|n> -> exit 0 = yes
  _yn_prompt=$1
  _yn_def=$2
  if [ "$_yn_def" = "y" ]; then _yn_hint="[Y/n] "; else _yn_hint="[y/N] "; fi
  ask "$_yn_prompt $_yn_hint" _yn_reply
  _yn_reply=$(printf '%s' "$_yn_reply" | tr '[:upper:]' '[:lower:]')
  [ -z "$_yn_reply" ] && _yn_reply=$_yn_def
  [ "$_yn_reply" = "y" ] || [ "$_yn_reply" = "yes" ]
}

# ---------------------------------------------------------------------------
# OS / arch detection
# ---------------------------------------------------------------------------
detect_os() {
  _detect_u=$(uname -s)
  case "$_detect_u" in
    Darwin) DETECTED_OS=darwin ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        DETECTED_OS=wsl
      else
        DETECTED_OS=linux
      fi
      ;;
    MINGW* | MSYS* | CYGWIN*) DETECTED_OS=windows-host ;;
    *) DETECTED_OS=unknown ;;
  esac
}

detect_arch() { # -> PD_ARCH: x64 | arm64
  _detect_m=$(uname -m)
  case "$_detect_m" in
    x86_64 | amd64) PD_ARCH=x64 ;;
    aarch64 | arm64) PD_ARCH=arm64 ;;
    *) PD_ARCH="$_detect_m" ;;
  esac
  export PD_ARCH
}

# ---------------------------------------------------------------------------
# Downloads (curl preferred, wget fallback)
# ---------------------------------------------------------------------------
fetch_to() { # fetch_to <url> <outfile>
  if command -v curl >/dev/null 2>&1; then
    run curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    run wget -qO "$2" "$1"
  else
    die "need curl or wget to download $1"
  fi
}

http_get() { # http_get <url> -> stdout (read-only)
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
  else
    die "need curl or wget to download $1"
  fi
}

# ---------------------------------------------------------------------------
# PATH management: put ~/.local/bin first on PATH (now) and in shell rc files
# (future shells), so installed CLIs (node, pnpm, gh, pi, pideck) resolve.
# ---------------------------------------------------------------------------
ensure_local_bin_path() {
  mkdir -p "$PD_LOCAL_BIN" 2>/dev/null || :
  case ":$PATH:" in
    *":$PD_LOCAL_BIN:"*) ;;
    *) PATH="$PD_LOCAL_BIN:$PATH" ;;
  esac
  export PATH

  # Intentionally single-quoted: this line is written verbatim into rc files.
  # shellcheck disable=SC2016
  _rc_line='export PATH="$HOME/.local/bin:$PATH"'
  if [ "$DETECTED_OS" = "darwin" ]; then
    _rc_files="$HOME/.zprofile $HOME/.zshrc $HOME/.profile"
  else
    _rc_files="$HOME/.profile $HOME/.bashrc"
  fi
  for _rc in $_rc_files; do
    if [ -f "$_rc" ]; then
      grep -qF '.local/bin' "$_rc" 2>/dev/null || run printf '\n%s\n' "$_rc_line" >> "$_rc"
    fi
  done
  # Guarantee at least one rc file carries the entry.
  if ! grep -qF '.local/bin' "$HOME/.profile" 2>/dev/null &&
    ! grep -qF '.local/bin' "$HOME/.zprofile" 2>/dev/null &&
    ! grep -qF '.local/bin' "$HOME/.zshrc" 2>/dev/null &&
    ! grep -qF '.local/bin' "$HOME/.bashrc" 2>/dev/null; then
    run sh -c "printf '\n%s\n' \"$_rc_line\" >> \"$HOME/.profile\""
  fi
}

# ---------------------------------------------------------------------------
# pideck env file (~/.pideck/env) — sourced by the service wrapper,
# the CLI, and later by the daemon. env_set keeps a single "KEY=\"value\"" line.
# ---------------------------------------------------------------------------
env_set() { # env_set <file> <KEY> <value>
  _es_file=$1
  _es_key=$2
  _es_val=$3
  if [ "$PD_DRY_RUN" = "1" ]; then
    printf "[dry-run] env_set %s=%s in %s\n" "$_es_key" "$_es_val" "$_es_file"
    return 0
  fi
  grep -v "^${_es_key}=" "$_es_file" > "$_es_file.tmp" 2>/dev/null || :
  printf '%s="%s"\n' "$_es_key" "$_es_val" >> "$_es_file.tmp"
  mv "$_es_file.tmp" "$_es_file"
}

# Minimal JSON string escaping for values we control.
json_str() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# Timestamp helper.
iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u; }
