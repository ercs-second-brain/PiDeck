# shellcheck shell=sh
#
# Dependency installation for the pideck installer:
#   git, Node.js >= 22, pnpm, gh CLI.
#
# Design: everything user-level installs into $PD_HOME/opt (private copies)
# with symlinks into ~/.local/bin — no sudo required for the main path.

# ---------------------------------------------------------------------------
# git
# ---------------------------------------------------------------------------
ensure_git() {
  step "Checking git"
  if command -v git >/dev/null 2>&1; then
    ok "git $(git --version | awk '{print $3}')"
    return 0
  fi
  case "$DETECTED_OS" in
    darwin)
      # git ships with the Xcode Command Line Tools; the installer dialog is
      # GUI-driven, so kick it off and poll.
      warn "git not found; installing Xcode Command Line Tools (a GUI dialog will appear)"
      run_ignore xcode-select --install
      info "waiting for git to become available (up to 10 minutes)..."
      _git_i=0
      while [ "$_git_i" -lt 60 ]; do
        if command -v git >/dev/null 2>&1; then break; fi
        sleep 10
        _git_i=$((_git_i + 1))
      done
      command -v git >/dev/null 2>&1 || die "git still missing; finish the Xcode CLT install and re-run"
      ok "git installed"
      ;;
    linux | wsl)
      # run_sudo dies with a clear message when neither root nor passwordless
      # sudo is available, instead of hanging on a password prompt.
      if command -v apt-get >/dev/null 2>&1; then
        run_sudo apt-get update -y
        run_sudo apt-get install -y git
      elif command -v dnf >/dev/null 2>&1; then
        run_sudo dnf install -y git
      elif command -v yum >/dev/null 2>&1; then
        run_sudo yum install -y git
      elif command -v pacman >/dev/null 2>&1; then
        run_sudo pacman -Sy --noconfirm git
      elif command -v apk >/dev/null 2>&1; then
        run_sudo apk add git
      elif command -v zypper >/dev/null 2>&1; then
        run_sudo zypper --non-interactive install git
      else
        die "git is required; install it with your package manager and re-run"
      fi
      command -v git >/dev/null 2>&1 || die "git installation failed; install it manually and re-run"
      ok "git installed"
      ;;
    *)
      die "git is required on this platform; install it and re-run"
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Node.js >= PD_NODE_MIN_VERSION (22.19.0: pi 0.75.0+ refuses older Node)
# ---------------------------------------------------------------------------
_node_majmin() { # -> _node_maj/_node_min from `node -v` (vMAJ.MIN.PATCH)
  _nm_v=$(node -v 2>/dev/null | sed 's/^v//')
  _node_maj=${_nm_v%%.*}
  _nm_rest=${_nm_v#*.}
  _node_min=${_nm_rest%%.*}
}

_node_meets_min() { # _node_meets_min <major> <minor> -> 0 when >= PD_NODE_MIN_VERSION
  _nmm_min_maj=${PD_NODE_MIN_VERSION%%.*}
  _nmm_rest=${PD_NODE_MIN_VERSION#*.}
  _nmm_min_min=${_nmm_rest%%.*}
  [ "$1" -gt "$_nmm_min_maj" ] 2>/dev/null && return 0
  [ "$1" -eq "$_nmm_min_maj" ] 2>/dev/null || return 1
  [ "$2" -ge "$_nmm_min_min" ] 2>/dev/null
}

ensure_node() {
  step "Checking Node.js >= $PD_NODE_MIN_VERSION"
  if command -v node >/dev/null 2>&1; then
    _node_majmin
    if _node_meets_min "$_node_maj" "$_node_min"; then
      PD_NODE_BIN=$(command -v node)
      PD_NODE_BIN_DIR=$(dirname "$PD_NODE_BIN")
      ok "using $(node -v) at $PD_NODE_BIN"
      return 0
    fi
    warn "found Node $(node -v) but pi needs >= $PD_NODE_MIN_VERSION; installing a private Node v$PD_NODE_VERSION"
  fi
  _install_node_tarball
  # Make sure the freshly installed node wins for the rest of the install.
  case ":$PATH:" in
    *":$PD_NODE_BIN_DIR:"*) ;;
    *) PATH="$PD_NODE_BIN_DIR:$PATH" ;;
  esac
  export PATH
  ok "installed Node $($PD_NODE_BIN -v) at $PD_NODE_BIN"
}

_install_node_tarball() {
  detect_arch
  _node_kind=$DETECTED_OS
  [ "$_node_kind" = "wsl" ] && _node_kind=linux
  _node_dirname="node-v$PD_NODE_VERSION-$_node_kind-$PD_ARCH"
  _node_dest="$PD_HOME/opt/$_node_dirname"

  if [ ! -x "$_node_dest/bin/node" ]; then
    # .tar.gz (not .tar.xz) so extraction works on stock macOS tar.
    _node_url="https://nodejs.org/dist/v$PD_NODE_VERSION/$_node_dirname.tar.gz"
    _node_tgz="$PD_HOME/opt/$_node_dirname.tar.gz"
    run mkdir -p "$PD_HOME/opt"
    info "downloading Node.js v$PD_NODE_VERSION ($_node_kind-$PD_ARCH)"
    fetch_to "$_node_url" "$_node_tgz"
    run tar -xzf "$_node_tgz" -C "$PD_HOME/opt"
    [ -d "$_node_dest" ] || die "unexpected Node tarball layout (no $_node_dirname/)"
    run rm -f "$_node_tgz"
  fi

  PD_NODE_BIN="$_node_dest/bin/node"
  PD_NODE_BIN_DIR="$_node_dest/bin"
  [ -x "$PD_NODE_BIN" ] || die "Node binary missing at $PD_NODE_BIN"
  ensure_local_bin_path
  for _node_tool in node npm npx corepack; do
    [ -e "$_node_dest/bin/$_node_tool" ] || continue
    run ln -sfn "$_node_dest/bin/$_node_tool" "$PD_LOCAL_BIN/$_node_tool"
  done
}

# ---------------------------------------------------------------------------
# pnpm (pinned by packageManager in the monorepo; installed standalone)
#
# "installed pnpm" must mean "pnpm runs", not "pnpm exists" (issue #162): a
# corepack shim passes command -v but resolves the monorepo's packageManager
# pin at build time with a possibly-empty corepack cache and dies with
# MODULE_NOT_FOUND mid-build. So corepack shims never count as usable and
# build_from_source always gets a real standalone pnpm from npm with a
# user-owned prefix, prepended to PATH ahead of any shim.
# ---------------------------------------------------------------------------
_pnpm_maj_ok() { # _pnpm_maj_ok <version> -> 0 when >= 9 (lockfile requirement)
  _pmo_maj=${1%%.*}
  [ "${_pmo_maj:-0}" -ge 9 ] 2>/dev/null
}

# A usable pnpm: on PATH, actually runs, is >= 9, and is not a corepack shim.
# Sets _pnpm_bin/_pnpm_ver on success (globals: POSIX sh has no locals).
_pnpm_usable() {
  command -v pnpm >/dev/null 2>&1 || return 1
  _pnpm_bin=$(command -v pnpm)
  grep -q corepack "$_pnpm_bin" 2>/dev/null && return 1
  _pnpm_ver=$(pnpm --version 2>/dev/null) || return 1
  _pnpm_maj_ok "$_pnpm_ver"
}

ensure_pnpm() {
  step "Checking pnpm"
  if _pnpm_usable; then
    # Keep this pnpm first on PATH for the rest of the install (build
    # included) so a broken shim earlier on PATH cannot shadow it later.
    _pnpm_dir=$(dirname "$_pnpm_bin")
    case ":$PATH:" in
      *":$_pnpm_dir:"*) ;;
      *) PATH="$_pnpm_dir:$PATH" ;;
    esac
    export PATH
    ok "using pnpm $_pnpm_ver at $_pnpm_bin"
    return 0
  fi
  if command -v pnpm >/dev/null 2>&1; then
    warn "pnpm at $(command -v pnpm) is a corepack shim, does not run, or is too old; installing a standalone one"
  fi

  ensure_local_bin_path
  _pnpm_prefix="$PD_HOME/opt/npm-global"
  # Real standalone pnpm via npm with a user-owned prefix — no corepack
  # involvement, so the build cannot hit an unpopulated corepack cache.
  run env NPM_CONFIG_PREFIX="$_pnpm_prefix" "$PD_NODE_BIN_DIR/npm" install -g "pnpm@$PD_PNPM_VERSION"
  run ln -sfn "$_pnpm_prefix/bin/pnpm" "$PD_LOCAL_BIN/pnpm"
  # The private prefix wins over any shim earlier on PATH.
  case ":$PATH:" in
    *":$_pnpm_prefix/bin:"*) ;;
    *) PATH="$_pnpm_prefix/bin:$PATH" ;;
  esac
  export PATH

  # Verify it RUNS before claiming success (issue #162).
  if ! _pnpm_ver=$(pnpm --version 2>/dev/null) || ! _pnpm_maj_ok "$_pnpm_ver"; then
    die "pnpm was installed but 'pnpm --version' failed — try 'npm install -g pnpm@$PD_PNPM_VERSION' manually, or check your npm registry access"
  fi
  ok "installed pnpm $_pnpm_ver at $(command -v pnpm)"
}

# ---------------------------------------------------------------------------
# gh CLI
# ---------------------------------------------------------------------------
ensure_gh() {
  step "Checking gh CLI"
  if command -v gh >/dev/null 2>&1; then
    ok "using gh $(gh --version | head -n 1 | awk '{print $3}') at $(command -v gh)"
    return 0
  fi

  detect_arch
  ensure_local_bin_path
  _gh_dest="$PD_HOME/opt/gh"
  if [ ! -x "$_gh_dest/bin/gh" ]; then
    run mkdir -p "$PD_HOME/opt" "$PD_HOME/opt/.gh-tmp"
    case "$DETECTED_OS" in
      darwin)
        # macOS releases are .zip (universal binaries ship per-arch zips).
        _gh_name="gh_${PD_GH_VERSION}_macOS_${PD_ARCH}"
        _gh_file="$_gh_name.zip"
        info "downloading gh v$PD_GH_VERSION (macOS-$PD_ARCH)"
        fetch_to "https://github.com/cli/cli/releases/download/v$PD_GH_VERSION/$_gh_file" "$PD_HOME/opt/.gh-tmp/$_gh_file"
        run unzip -oq "$PD_HOME/opt/.gh-tmp/$_gh_file" -d "$PD_HOME/opt/.gh-tmp"
        ;;
      linux | wsl)
        case "$PD_ARCH" in
          x64) _gh_arch=amd64 ;;
          arm64) _gh_arch=arm64 ;;
          *) die "unsupported architecture for gh: $PD_ARCH" ;;
        esac
        _gh_name="gh_${PD_GH_VERSION}_linux_$_gh_arch"
        _gh_file="$_gh_name.tar.gz"
        info "downloading gh v$PD_GH_VERSION (linux-$_gh_arch)"
        fetch_to "https://github.com/cli/cli/releases/download/v$PD_GH_VERSION/$_gh_file" "$PD_HOME/opt/.gh-tmp/$_gh_file"
        run tar -xzf "$PD_HOME/opt/.gh-tmp/$_gh_file" -C "$PD_HOME/opt/.gh-tmp"
        ;;
      *)
        die "gh is required on this platform; install it and re-run"
        ;;
    esac
    [ -x "$PD_HOME/opt/.gh-tmp/$_gh_name/bin/gh" ] || die "unexpected gh archive layout (no $_gh_name/bin/gh)"
    run rm -rf "$_gh_dest"
    run mv "$PD_HOME/opt/.gh-tmp/$_gh_name" "$_gh_dest"
    run rm -rf "$PD_HOME/opt/.gh-tmp"
  fi

  run ln -sfn "$_gh_dest/bin/gh" "$PD_LOCAL_BIN/gh"
  command -v gh >/dev/null 2>&1 || die "gh installation failed"
  ok "installed gh $(gh --version | head -n 1 | awk '{print $3}')"
}
