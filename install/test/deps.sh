#!/bin/sh
# shellcheck shell=sh disable=SC2154,SC1091 # failures comes from the sourced harness
# Plain-shell tests for lib/deps.sh's pnpm handling (issue #162, no bats
# dependency — matches install/'s shell-only tooling). Covers: ensure_pnpm
# must yield a pnpm that RUNS for build_from_source — a broken corepack shim
# (empty cache for the pinned packageManager) must be bypassed with a real
# standalone pnpm from the private npm prefix, a working non-shim pnpm must
# be reused, and a failed install must die with actionable guidance.
set -u

# shellcheck disable=SC1091 # shared test harness, sourced on purpose
. "$(dirname -- "$0")/harness.sh"

# Full env isolation: common.sh/deps.sh write rc files under $HOME, install
# under PD_HOME, and mutate PATH — all inside this test's temp dir.
export HOME="$tmp/home"
export PD_HOME="$tmp/pd-home"
PD_DRY_RUN=0
export PD_DRY_RUN
PD_NONINTERACTIVE=1
export PD_NONINTERACTIVE

# shellcheck disable=SC1091 # installer libs, sourced on purpose
. "$INSTALL_DIR/lib/common.sh"
. "$INSTALL_DIR/lib/deps.sh"

# --- fake node: only the npm stub that ensure_pnpm's install path calls ----
NODE_BIN_DIR="$tmp/node/bin"
mkdir -p "$NODE_BIN_DIR"
make_npm_stub() { # make_npm_stub <dir> <exit-code>
  mkdir -p "$1"
  cat > "$1/npm" <<EOF
#!/bin/sh
[ "\$1 \$2 \$3" = "install -g pnpm@\$PD_PNPM_VERSION" ] || exit 9
[ "$2" = "0" ] || { printf 'npm: registry unreachable\n' >&2; exit "$2"; }
mkdir -p "\$NPM_CONFIG_PREFIX/bin"
printf '#!/bin/sh\nprintf '"'"'12.3.4\\n'"'"'\n' > "\$NPM_CONFIG_PREFIX/bin/pnpm"
chmod +x "\$NPM_CONFIG_PREFIX/bin/pnpm"
EOF
  chmod +x "$1/npm"
}
make_npm_stub "$NODE_BIN_DIR" 0
# (consumed by the sourced deps.sh, not directly in this file)
# shellcheck disable=SC2034
export PD_NODE_BIN_DIR
PD_NODE_BIN_DIR="$NODE_BIN_DIR"

make_pnpm() { # make_pnpm <dir> <version-or-broken> <is-shim>
  mkdir -p "$1"
  if [ "$2" = "broken" ]; then
    cat > "$1/pnpm" <<'EOF'
#!/bin/sh
printf 'error: Cannot find module corepack/v1/pnpm/12.3.4/bin/pnpm.cjs\n' >&2
exit 1
EOF
  else
    # $2 expands at stub-generation time; the stub's $1 stays literal.
    cat > "$1/pnpm" <<EOF
#!/bin/sh
[ "\$1" = --version ] && printf '%s\n' "$2"
EOF
  fi
  if [ "$3" = "shim" ]; then
    printf '# corepack shim (managed by corepack enable)\n' >> "$1/pnpm"
  fi
  chmod +x "$1/pnpm"
}

# --- ensure_pnpm in an isolated subshell (it mutates PATH, and die exits) --
# The inner subshell dumps its final PATH via an EXIT trap so the resolution
# checks below observe the PATH ensure_pnpm exported (the build's PATH), even
# when ensure_pnpm dies. Output: installer messages, rc=<n>, then
# "resolved <path> <version>" when a pnpm resolves at all.
run_ensure() { # run_ensure <initial-PATH>
  (
    # shellcheck disable=SC2030 # PATH isolation inside this subshell is the point
    PATH="$1"
    export PATH
    (
      trap 'printf "FINALPATH=%s\n" "$PATH"' EXIT
      ensure_pnpm
    ) > "$tmp/ensure.out" 2>&1
    rc=$?
    grep -v '^FINALPATH=' "$tmp/ensure.out"
    printf 'rc=%s\n' "$rc"
    _re_path=$(sed -n 's/^FINALPATH=//p' "$tmp/ensure.out" | tail -n 1)
    if [ -n "$_re_path" ]; then
      PATH="$_re_path"
      export PATH
    fi
    if command -v pnpm >/dev/null 2>&1; then
      printf 'resolved %s %s\n' "$(command -v pnpm)" "$(pnpm --version 2>/dev/null || echo FAIL)"
    fi
  )
}

# --- broken corepack shim + empty cache: the #162 repro --------------------
make_pnpm "$tmp/shim" broken shim
out=$(run_ensure "$tmp/shim:$NODE_BIN_DIR:/usr/bin:/bin")
check_grep 'broken shim: install announces ok' '[ok] installed pnpm 12.3.4' "$out"
check_grep 'broken shim: build resolves the standalone pnpm' \
  "resolved $PD_HOME/opt/npm-global/bin/pnpm 12.3.4" "$out"
check_eq 'broken shim: exits 0' 'rc=0' "$(printf '%s\n' "$out" | grep '^rc=' )"
check_grep 'broken shim: shim flagged' 'corepack shim' "$out"
_ln_ok=0
[ -L "$HOME/.local/bin/pnpm" ] && [ -x "$HOME/.local/bin/pnpm" ] && _ln_ok=1
check_eq 'broken shim: ~/.local/bin/pnpm symlinked' '1' "$_ln_ok"

# --- working corepack shim (passes --version!) still bypassed --------------
make_pnpm "$tmp/shim-ok" 9.15.9 shim
out=$(run_ensure "$tmp/shim-ok:$NODE_BIN_DIR:/usr/bin:/bin")
check_grep 'working shim: not trusted for the build' '[ok] installed pnpm 12.3.4' "$out"
check_grep 'working shim: standalone pnpm wins' \
  "resolved $PD_HOME/opt/npm-global/bin/pnpm 12.3.4" "$out"

# --- broken shim shadowing a working pnpm further down PATH ----------------
make_pnpm "$tmp/working" 10.5.0 plain
out=$(run_ensure "$tmp/shim:$tmp/working:$NODE_BIN_DIR:/usr/bin:/bin")
check_grep 'shadowed pnpm: standalone install still wins over shim' \
  "resolved $PD_HOME/opt/npm-global/bin/pnpm 12.3.4" "$out"

# --- good standalone pnpm already present: reused, npm not touched ---------
# (previous tests populated the shared fake prefix; drop it so the reuse
# assertion observes this run's side effects only)
run_ignore rm -rf "$PD_HOME/opt"
out=$(run_ensure "$tmp/working:$NODE_BIN_DIR:/usr/bin:/bin")
check_grep 'good pnpm: reused' '[ok] using pnpm 10.5.0' "$out"
check_grep 'good pnpm: resolves to the pre-installed one' 'resolved '"$tmp"'/working/pnpm 10.5.0' "$out"
check_eq 'good pnpm: npm never invoked' '' \
  "$(find "$PD_HOME/opt" -name pnpm 2>/dev/null | grep npm-global || :)"

# --- too-old pnpm: replaced with a standalone one --------------------------
make_pnpm "$tmp/old" 8.10.5 plain
out=$(run_ensure "$tmp/old:$NODE_BIN_DIR:/usr/bin:/bin")
check_grep 'old pnpm: replaced' '[ok] installed pnpm 12.3.4' "$out"

# --- npm install fails: die with actionable guidance -----------------------
# (drop the fake prefix earlier tests populated, so the dangling-ln failure
# path is exercised, and point $PD_NODE_BIN_DIR at the failing npm stub)
run_ignore rm -rf "$PD_HOME/opt"
make_npm_stub "$tmp/node-bad/bin" 1
PD_NODE_BIN_DIR="$tmp/node-bad/bin"
out=$(run_ensure "$tmp/shim:$tmp/node-bad/bin:/usr/bin:/bin")
check_grep 'npm failure: exits nonzero' 'rc=1' "$out"
check_grep 'npm failure: actionable guidance' 'npm install -g pnpm@' "$out"

# --- node version floor: >= 22.19.0 enforced (pi 0.75.0+ requirement) ------
_node_floor_probe() { # _node_floor_probe <major> <minor> -> "<exit code of deps.sh's _node_meets_min>"
  (
    # consumed by the deps.sh sourced right below
    # shellcheck disable=SC2034
    export PD_NODE_MIN_VERSION="22.19.0"
    # shellcheck disable=SC1091 # installer lib, sourced on purpose
    . "$INSTALL_DIR/lib/deps.sh"
    _node_meets_min "$1" "$2"
    echo $? # command substitution captures stdout, not the exit code
  )
}
check_eq 'node floor: 22.19.0 passes' '0' "$(_node_floor_probe 22 19)"
check_eq 'node floor: 22.23.2 passes' '0' "$(_node_floor_probe 22 23)"
check_eq 'node floor: 23.0.0 passes' '0' "$(_node_floor_probe 23 0)"
check_eq 'node floor: 22.14.0 fails' '1' "$(_node_floor_probe 22 14)"
check_eq 'node floor: 21.9.9 fails' '1' "$(_node_floor_probe 21 9)"

# --- summary ----------------------------------------------------------------
if [ "$failures" -eq 0 ]; then
  printf '# all deps tests passed\n'
  exit 0
fi
printf '# %s test(s) failed\n' "$failures" >&2
exit 1
