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
export PD_NODE_VERSION="${PD_NODE_VERSION:-22.23.2}" # newest 22.x on nodejs.org (pi 0.75.0+ needs >= 22.19.0)
export PD_NODE_MIN_VERSION="${PD_NODE_MIN_VERSION:-22.19.0}" # floor enforced by ensure_node
export PD_PNPM_VERSION="${PD_PNPM_VERSION:-12}" # major; the monorepo pins the exact version
export PD_GH_VERSION="${PD_GH_VERSION:-2.63.2}"
export PD_PI_NPM_PACKAGE="${PD_PI_PACKAGE:-@earendil-works/pi-coding-agent}"
export PD_PI_DIR="${PD_PI_DIR:-${PD_PI_DIR:-$HOME/.pi/agent}}"
export PD_LOCAL_BIN="$HOME/.local/bin"
# Corepack shims download their package manager on first use; never prompt
# mid-install (covers ensure_pnpm's verification and the build's pnpm calls).
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Set once OS detection ran (detect_os).
DETECTED_OS="unknown" # darwin | linux | wsl | windows-host | unknown

# maintain_local_bin_shims — keep ~/.local/bin CLI entries pointing at the
# installed shims (issue #215).
#
# Pre-#163 installs copied REAL-file shims into ~/.local/bin
# (install_bin_compat); PATH resolves ~/.local/bin first, so such a file
# shadows the refreshed $PD_HOME/bin shim forever (observed live: a
# fe43fa0-era shim with syntax errors kept breaking the CLI after a
# successful update that only refreshed ~/.pideck/bin). For each name:
#   correct symlink to $PD_HOME/bin/<name>  -> no-op
#   real file / foreign or dangling symlink -> replaced by the canonical symlink
#   absent                                  -> left alone (bootstrap owns creation)
maintain_local_bin_shims() { # maintain_local_bin_shims <name>...
  for _mlb_name in "$@"; do
    _mlb_link="$PD_LOCAL_BIN/$_mlb_name"
    _mlb_target="$PD_HOME/bin/$_mlb_name"
    if [ ! -e "$_mlb_link" ] && [ ! -L "$_mlb_link" ]; then
      continue # absent — bootstrap decides whether the entry should exist
    fi
    if [ -L "$_mlb_link" ] && [ "$(readlink "$_mlb_link")" = "$_mlb_target" ]; then
      continue # already the canonical symlink
    fi
    info "replacing stale ~/.local/bin/$_mlb_name with a symlink to $_mlb_target"
    run rm -f "$_mlb_link"
    run ln -s "$_mlb_target" "$_mlb_link"
  done
}

# ---------------------------------------------------------------------------
# Shell-layer install (shared by bootstrap.sh and the update path): copy the
# fetched tree's CLI shims into $PD_HOME/bin and the libs + onboard.sh flat
# into <lib-dir> (see issue #65), keep the ~/.local/bin/pideck symlink, and
# convert stale real-file ~/.local/bin shims into symlinks (issue #215).
# ---------------------------------------------------------------------------
install_shell_layer() { # install_shell_layer <lib-dir>
  _isl_lib=$1
  for _cli_file in "$PD_SRC/install/bin/"*; do
    [ -f "$_cli_file" ] || continue
    # Issue #215: never deploy a shim that does not parse — a broken shim on
    # PATH bricks the CLI. sh -n is a read-only syntax check.
    if ! sh -n "$_cli_file" 2>/dev/null; then
      die "refusing to deploy a shim that fails sh -n: $_cli_file"
    fi
    run cp "$_cli_file" "$PD_HOME/bin/$(basename "$_cli_file")"
    run chmod +x "$PD_HOME/bin/$(basename "$_cli_file")"
  done
  for _lib_file in "$PD_SRC/install/lib/"*.sh "$PD_SRC/install/onboard.sh"; do
    [ -f "$_lib_file" ] || continue
    run cp "$_lib_file" "$_isl_lib/$(basename "$_lib_file")"
  done
  run mkdir -p "$PD_LOCAL_BIN"
  # Issue #215: convert stale real-file/foreign ~/.local/bin shims FIRST, so
  # the conversion is explicit (and rm -f robust); the ln below then only
  # (re)creates the canonical pideck symlink.
  maintain_local_bin_shims pideck pideck-daemon
  run ln -sfn "$PD_HOME/bin/pideck" "$PD_LOCAL_BIN/pideck"
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
# Version comparison, shared by the update path's Node refresh (update.sh)
# and the pi engines check (assets.sh, issue #202).
# ---------------------------------------------------------------------------
# _node_version_ge <a> <b> — 0 when version string a >= b (MAJ.MIN.PATCH).
_node_version_ge() {
  _ng_a1=$(printf '%s' "$1" | cut -d. -f1)
  _ng_a2=$(printf '%s' "$1" | cut -d. -f2)
  _ng_a3=$(printf '%s' "$1" | cut -d. -f3)
  _ng_b1=$(printf '%s' "$2" | cut -d. -f1)
  _ng_b2=$(printf '%s' "$2" | cut -d. -f2)
  _ng_b3=$(printf '%s' "$2" | cut -d. -f3)
  [ "${_ng_a1:-0}" -gt "${_ng_b1:-0}" ] && return 0
  [ "${_ng_a1:-0}" -lt "${_ng_b1:-0}" ] && return 1
  [ "${_ng_a2:-0}" -gt "${_ng_b2:-0}" ] && return 0
  [ "${_ng_a2:-0}" -lt "${_ng_b2:-0}" ] && return 1
  [ "${_ng_a3:-0}" -ge "${_ng_b3:-0}" ]
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
