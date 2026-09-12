#!/bin/sh
# shellcheck shell=sh disable=SC2154 # failures comes from the sourced harness
# Plain-shell tests for install/onboard.sh. Covers: the flat installed layout
# (bootstrap copies lib/*.sh + onboard.sh side by side into ~/.pideck/lib/),
# the required review account (noninteractive runs fail without it, succeed
# with PD_REVIEW_USER/PD_REVIEW_TOKEN, and a rejected token fails), and the
# settings.json contract the daemon reads (model + review username + token,
# owner-only permissions). No network, no real pi/gh/auth side effects.
set -u

# shellcheck disable=SC1091 # shared test harness, sourced on purpose
. "$(dirname -- "$0")/harness.sh"

# --- stub gh: auth status succeeds unless the token is rejected; api user ---
# prints the account the token belongs to.
fakebin="$tmp/fakebin"
mkdir -p "$fakebin"
cat > "$fakebin/gh" <<'EOF'
#!/bin/sh
case "$1" in
  auth)
    case "${GH_TOKEN:-}" in
      badtoken) printf 'error: bad credentials\n' >&2; exit 1 ;;
    esac
    exit 0
    ;;
  api)
    if [ -n "${GH_TOKEN:-}" ]; then
      printf '%s\n' "${FAKE_TOKEN_LOGIN:-reviewer}"
    else
      printf '%s\n' 'primary'
    fi
    ;;
esac
exit 0
EOF
chmod +x "$fakebin/gh"

# --- flat installed layout, replicated exactly as bootstrap.sh does it ------
PD_HOME="$tmp/home"
mkdir -p "$PD_HOME/lib"
cp "$INSTALL_DIR/lib/"*.sh "$PD_HOME/lib/"
cp "$INSTALL_DIR/onboard.sh" "$PD_HOME/lib/"
if [ -f "$PD_HOME/lib/onboard.sh" ] && [ -f "$PD_HOME/lib/common.sh" ] && [ ! -d "$PD_HOME/lib/lib" ]; then :; else
  printf 'not ok - test setup: flat copy of install/ into %s/lib\n' "$PD_HOME"
  exit 1
fi

# --- dry-run: skips the review prompts, never fails -------------------------
export PD_HOME
out=$(PATH="$fakebin:$PATH" sh "$PD_HOME/lib/onboard.sh" --dry-run --skip-pi --skip-gh 2>&1)
rc=$?
check_eq 'dry-run exits 0' '0' "$rc"
check_grep 'dry-run ran onboarding' 'onboarding summary' "$out"
check_grep 'dry-run review step printed' "[dry-run] prompt for review account" "$out"
check_grep 'dry-run settings write printed' '[dry-run] write' "$out"

# --- noninteractive without review credentials: REQUIRED step fails ---------
out=$(env -u PD_REVIEW_USER -u PD_REVIEW_TOKEN PATH="$fakebin:$PATH" \
  sh "$PD_HOME/lib/onboard.sh" --noninteractive --skip-pi --skip-gh 2>&1)
rc=$?
check_eq 'missing review account exits nonzero' '1' "$rc"
check_grep 'missing review account is reported' 'review account is missing or unverified' "$out"
check_eq 'no settings written without review account' '' "$(cat "$PD_HOME/settings.json" 2>/dev/null || :)"

# --- noninteractive with review credentials: verified + written -------------
out=$(env PATH="$fakebin:$PATH" PD_REVIEW_USER=reviewer PD_REVIEW_TOKEN=ghp_good \
  sh "$PD_HOME/lib/onboard.sh" --noninteractive --skip-pi --skip-gh 2>&1)
rc=$?
check_eq 'review credentials verified: exits 0' '0' "$rc"
check_grep 'review account verified in output' 'review account verified: reviewer' "$out"
check_grep 'token rejection path not taken' 'review account verified' "$out"

if [ -f "$PD_HOME/settings.json" ]; then
  check_eq 'settings record the review username' 'reviewer' \
    "$(sed -n 's/.*"username": "\([^"]*\)".*/\1/p' "$PD_HOME/settings.json")"
  check_eq 'settings record the review token' 'ghp_good' \
    "$(sed -n 's/.*"token": "\([^"]*\)".*/\1/p' "$PD_HOME/settings.json")"
  # Portable owner-only check: ls -l perms field is -rw------- on GNU and BSD.
  # shellcheck disable=SC2012 # ls is the portable way to read perms here
  check_eq 'settings are owner-only' '-rw-------' \
    "$(ls -l "$PD_HOME/settings.json" | awk '{print $1}')"
else
  check_grep 'settings written for the daemon' 'settings.json exists' 'MISSING'
fi
check_grep 'onboarding record marks review ready' '"status": "ready"' "$(cat "$PD_HOME/onboarding.json" 2>/dev/null)"
check_grep 'onboarding record stores the review username' '"username": "reviewer"' "$(cat "$PD_HOME/onboarding.json" 2>/dev/null)"

# --- mismatched review token owner: verification fails ----------------------
out=$(env PATH="$fakebin:$PATH" FAKE_TOKEN_LOGIN=someone_else PD_REVIEW_USER=reviewer PD_REVIEW_TOKEN=ghp_good \
  sh "$PD_HOME/lib/onboard.sh" --noninteractive --skip-pi --skip-gh 2>&1)
rc=$?
check_eq 'mismatched token owner exits nonzero' '1' "$rc"
check_grep 'mismatch reported' "the review token belongs to 'someone_else', not 'reviewer'" "$out"

# --- rejected review token: verification fails ------------------------------
out=$(env PATH="$fakebin:$PATH" PD_REVIEW_USER=reviewer PD_REVIEW_TOKEN=badtoken \
  sh "$PD_HOME/lib/onboard.sh" --noninteractive --skip-pi --skip-gh 2>&1)
rc=$?
check_eq 'rejected token exits nonzero' '1' "$rc"
check_grep 'rejection reported' 'gh rejected the review token' "$out"

# --- summary ----------------------------------------------------------------
if [ "$failures" -eq 0 ]; then
  printf '# all onboard tests passed\n'
  exit 0
fi
printf '# %s test(s) failed\n' "$failures" >&2
exit 1
