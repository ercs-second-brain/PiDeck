# shellcheck shell=sh
#
# Shared helpers for the agentskiss installer (POSIX sh, no bashisms).
#
# Sourced by bootstrap.sh, onboard.sh, uninstall.sh and the agentskiss CLI.
# Never executed directly.

set -u

# ---------------------------------------------------------------------------
# Defaults (overridable via environment or CLI flags).
# Exported: they are consumed by the sibling scripts that source this file
# and by installer-launched children.
# ---------------------------------------------------------------------------
export AK_HOME="${AGENTSKISS_HOME:-${AK_HOME:-$HOME/.agentskiss}}"
AK_DRY_RUN="${AK_DRY_RUN:-0}"
AK_NONINTERACTIVE="${AK_NONINTERACTIVE:-0}"
export AK_REPO_URL="${AGENTSKISS_REPO_URL:-https://github.com/ercs-second-brain/agentsKISS.git}"
export AK_REPO_REF="${AGENTSKISS_REPO_REF:-main}"
export AK_WEB_PORT="${AGENTSKISS_WEB_PORT:-8321}"
export AK_NODE_VERSION="${AGENTSKISS_NODE_VERSION:-22.14.0}"
export AK_GH_VERSION="${AGENTSKISS_GH_VERSION:-2.63.2}"
export AK_PI_NPM_PACKAGE="${AGENTSKISS_PI_PACKAGE:-@earendil-works/pi-coding-agent}"
export AK_PI_DIR="${AGENTSKISS_PI_DIR:-${AK_PI_DIR:-$HOME/.pi/agent}}"
export AK_LOCAL_BIN="$HOME/.local/bin"
# Corepack shims download their package manager on first use; never prompt
# mid-install (covers ensure_pnpm's verification and the build's pnpm calls).
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Set once OS detection ran (detect_os).
DETECTED_OS="unknown" # darwin | linux | wsl | windows-host | unknown

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
_ak_tty() { [ -t 2 ]; }

info() {
  if _ak_tty; then printf '\033[1;34m==>\033[0m %s\n' "$*"; else printf '==> %s\n' "$*"; fi
}
step() {
  if _ak_tty; then printf '\033[1;36m-->\033[0m %s\n' "$*"; else printf '%s\n' "--> $*"; fi
}
warn() {
  if _ak_tty; then printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; else printf 'warning: %s\n' "$*" >&2; fi
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
  if [ "$AK_DRY_RUN" = "1" ]; then
    printf '[dry-run]'
    for _arg in "$@"; do printf " '%s'" "$_arg"; done
    printf '\n'
    return 0
  fi
  "$@"
}

# Like run(), but failures are non-fatal (best-effort steps).
run_ignore() {
  if [ "$AK_DRY_RUN" = "1" ]; then
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
  if [ "$AK_NONINTERACTIVE" = "1" ]; then
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

detect_arch() { # -> AK_ARCH: x64 | arm64
  _detect_m=$(uname -m)
  case "$_detect_m" in
    x86_64 | amd64) AK_ARCH=x64 ;;
    aarch64 | arm64) AK_ARCH=arm64 ;;
    *) AK_ARCH="$_detect_m" ;;
  esac
  export AK_ARCH
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
# (future shells), so installed CLIs (node, pnpm, gh, pi, agentskiss) resolve.
# ---------------------------------------------------------------------------
ensure_local_bin_path() {
  mkdir -p "$AK_LOCAL_BIN" 2>/dev/null || :
  case ":$PATH:" in
    *":$AK_LOCAL_BIN:"*) ;;
    *) PATH="$AK_LOCAL_BIN:$PATH" ;;
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
# agentskiss env file (~/.agentskiss/env) — sourced by the service wrapper,
# the CLI, and later by the daemon. env_set keeps a single "KEY=\"value\"" line.
# ---------------------------------------------------------------------------
env_set() { # env_set <file> <KEY> <value>
  _es_file=$1
  _es_key=$2
  _es_val=$3
  if [ "$AK_DRY_RUN" = "1" ]; then
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
