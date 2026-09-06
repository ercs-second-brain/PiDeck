# shellcheck shell=sh
#
# Dependency installation for the agentskiss installer:
#   git, Node.js >= 22, pnpm, gh CLI.
#
# Design: everything user-level installs into $AK_HOME/opt (private copies)
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
# Node.js >= 22
# ---------------------------------------------------------------------------
_node_major() {
  node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'
}

ensure_node() {
  step "Checking Node.js >= 22"
  if command -v node >/dev/null 2>&1; then
    _node_maj=$(_node_major)
    if [ "${_node_maj:-0}" -ge 22 ] 2>/dev/null; then
      AK_NODE_BIN=$(command -v node)
      AK_NODE_BIN_DIR=$(dirname "$AK_NODE_BIN")
      ok "using $(node -v) at $AK_NODE_BIN"
      return 0
    fi
    warn "found Node $(node -v) but agentskiss needs >= 22; installing a private Node v$AK_NODE_VERSION"
  fi
  _install_node_tarball
  # Make sure the freshly installed node wins for the rest of the install.
  case ":$PATH:" in
    *":$AK_NODE_BIN_DIR:"*) ;;
    *) PATH="$AK_NODE_BIN_DIR:$PATH" ;;
  esac
  export PATH
  ok "installed Node $($AK_NODE_BIN -v) at $AK_NODE_BIN"
}

_install_node_tarball() {
  detect_arch
  _node_kind=$DETECTED_OS
  [ "$_node_kind" = "wsl" ] && _node_kind=linux
  _node_dirname="node-v$AK_NODE_VERSION-$_node_kind-$AK_ARCH"
  _node_dest="$AK_HOME/opt/$_node_dirname"

  if [ ! -x "$_node_dest/bin/node" ]; then
    # .tar.gz (not .tar.xz) so extraction works on stock macOS tar.
    _node_url="https://nodejs.org/dist/v$AK_NODE_VERSION/$_node_dirname.tar.gz"
    _node_tgz="$AK_HOME/opt/$_node_dirname.tar.gz"
    run mkdir -p "$AK_HOME/opt"
    info "downloading Node.js v$AK_NODE_VERSION ($_node_kind-$AK_ARCH)"
    fetch_to "$_node_url" "$_node_tgz"
    run tar -xzf "$_node_tgz" -C "$AK_HOME/opt"
    [ -d "$_node_dest" ] || die "unexpected Node tarball layout (no $_node_dirname/)"
    run rm -f "$_node_tgz"
  fi

  AK_NODE_BIN="$_node_dest/bin/node"
  AK_NODE_BIN_DIR="$_node_dest/bin"
  [ -x "$AK_NODE_BIN" ] || die "Node binary missing at $AK_NODE_BIN"
  ensure_local_bin_path
  for _node_tool in node npm npx corepack; do
    [ -e "$_node_dest/bin/$_node_tool" ] || continue
    run ln -sfn "$_node_dest/bin/$_node_tool" "$AK_LOCAL_BIN/$_node_tool"
  done
}

# ---------------------------------------------------------------------------
# pnpm (pinned by packageManager in the monorepo; corepack resolves it)
# ---------------------------------------------------------------------------
ensure_pnpm() {
  step "Checking pnpm"
  if command -v pnpm >/dev/null 2>&1; then
    _pnpm_ver=$(pnpm --version 2>/dev/null || echo 0)
    _pnpm_maj=${_pnpm_ver%%.*}
    if [ "${_pnpm_maj:-0}" -ge 9 ] 2>/dev/null; then
      ok "using pnpm $_pnpm_ver at $(command -v pnpm)"
      return 0
    fi
    warn "pnpm $_pnpm_ver is too old; installing a current one"
  fi

  ensure_local_bin_path
  _pnpm_corepack="$AK_NODE_BIN_DIR/corepack"
  if [ -x "$_pnpm_corepack" ]; then
    # corepack shims respect the monorepo's packageManager pin.
    run env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$_pnpm_corepack" enable --install-directory "$AK_LOCAL_BIN" pnpm
  else
    # Some distro Node builds strip corepack — fall back to npm with a
    # user-owned prefix.
    run env NPM_CONFIG_PREFIX="$AK_HOME/opt/npm-global" "$AK_NODE_BIN_DIR/npm" install -g pnpm
    run ln -sfn "$AK_HOME/opt/npm-global/bin/pnpm" "$AK_LOCAL_BIN/pnpm"
  fi

  command -v pnpm >/dev/null 2>&1 || die "pnpm installation failed"
  ok "installed pnpm $(pnpm --version)"
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
  _gh_dest="$AK_HOME/opt/gh"
  if [ ! -x "$_gh_dest/bin/gh" ]; then
    run mkdir -p "$AK_HOME/opt" "$AK_HOME/opt/.gh-tmp"
    case "$DETECTED_OS" in
      darwin)
        # macOS releases are .zip (universal binaries ship per-arch zips).
        _gh_name="gh_${AK_GH_VERSION}_macOS_${AK_ARCH}"
        _gh_file="$_gh_name.zip"
        info "downloading gh v$AK_GH_VERSION (macOS-$AK_ARCH)"
        fetch_to "https://github.com/cli/cli/releases/download/v$AK_GH_VERSION/$_gh_file" "$AK_HOME/opt/.gh-tmp/$_gh_file"
        run unzip -oq "$AK_HOME/opt/.gh-tmp/$_gh_file" -d "$AK_HOME/opt/.gh-tmp"
        ;;
      linux | wsl)
        case "$AK_ARCH" in
          x64) _gh_arch=amd64 ;;
          arm64) _gh_arch=arm64 ;;
          *) die "unsupported architecture for gh: $AK_ARCH" ;;
        esac
        _gh_name="gh_${AK_GH_VERSION}_linux_$_gh_arch"
        _gh_file="$_gh_name.tar.gz"
        info "downloading gh v$AK_GH_VERSION (linux-$_gh_arch)"
        fetch_to "https://github.com/cli/cli/releases/download/v$AK_GH_VERSION/$_gh_file" "$AK_HOME/opt/.gh-tmp/$_gh_file"
        run tar -xzf "$AK_HOME/opt/.gh-tmp/$_gh_file" -C "$AK_HOME/opt/.gh-tmp"
        ;;
      *)
        die "gh is required on this platform; install it and re-run"
        ;;
    esac
    [ -x "$AK_HOME/opt/.gh-tmp/$_gh_name/bin/gh" ] || die "unexpected gh archive layout (no $_gh_name/bin/gh)"
    run rm -rf "$_gh_dest"
    run mv "$AK_HOME/opt/.gh-tmp/$_gh_name" "$_gh_dest"
    run rm -rf "$AK_HOME/opt/.gh-tmp"
  fi

  run ln -sfn "$_gh_dest/bin/gh" "$AK_LOCAL_BIN/gh"
  command -v gh >/dev/null 2>&1 || die "gh installation failed"
  ok "installed gh $(gh --version | head -n 1 | awk '{print $3}')"
}
