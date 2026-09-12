#!/bin/sh
# shellcheck shell=sh disable=SC1091
#
# PiDeck guided onboarding.
#
#  1. pi auth + model selection — shells out to the pi CLI's own auth
#     (`pi auth check`, interactive `/login` in the pi TUI); we never
#     reimplement auth, we only detect it and launch pi when needed.
#  2. primary gh auth — uses a PAT from ~/.env (GH_TOKEN/GITHUB_TOKEN) when
#     present, else walks through `gh auth login`; verifies the result.
#  3. review account — REQUIRED: a second GitHub account. The primary path is
#     gh's own device flow under a dedicated config dir
#     (GH_CONFIG_DIR=$PD_HOME/state/gh-review gh auth login --web): a
#     one-time code + URL is shown, the user signs in as the review account in
#     the browser, and the token + username are read back from that config
#     dir. A username + PAT prompt remains as the fallback. The PR review leg
#     cannot run without it, so onboarding does not complete until the account
#     is set and verified.
#
# Results are written to ~/.pideck/onboarding.json (record), and the review
# account + per-persona model to ~/.pideck/settings.json in the shared
# GlobalSettingsSchema shape (packages/shared/src/settings.ts; read by the
# daemon), both remembered across restarts.
#
# Usage:
#   install/onboard.sh [--dry-run] [--noninteractive] [--skip-pi] [--skip-gh]
#
# Noninteractive runs supply the review account via PD_REVIEW_USER +
# PD_REVIEW_TOKEN. Also reachable post-install via: pideck onboard

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# Two layouts reach this script:
#   source tree:  install/onboard.sh with install/lib/*.sh as a sibling dir
#   installed:    bootstrap.sh copies install/lib/*.sh AND install/onboard.sh
#                 flat into ~/.pideck/lib/ — the libs sit next to us
if [ -f "$script_dir/lib/common.sh" ]; then
  . "$script_dir/lib/common.sh"
elif [ -f "$script_dir/common.sh" ]; then
  . "$script_dir/common.sh"
else
  printf 'error: install libs (common.sh) not found next to %s — re-run the installer\n' "$(basename -- "$0")" >&2
  exit 1
fi

PD_PI_PROVIDERS="anthropic openai google google-vertex openai-codex openrouter github-copilot xai groq mistral amazon-bedrock zai nvidia"

usage() {
  cat <<'EOF'
Usage: onboard.sh [--dry-run] [--noninteractive] [--skip-pi] [--skip-gh]

Guided onboarding for PiDeck: pi auth + model selection, primary gh auth,
and the required review account (second GitHub account). Results are
recorded under ~/.pideck/ and remembered across restarts.

Environment (noninteractive runs):
  PD_REVIEW_USER    review account username
  PD_REVIEW_TOKEN   review account personal access token
  PD_REVIEW_DEVICE  1 forces the device sign-in in noninteractive runs
EOF
}

# ---------------------------------------------------------------------------
# pi auth
# ---------------------------------------------------------------------------
_pi_ready_providers() {
  _prp_out=""
  for _prp_p in $PD_PI_PROVIDERS; do
    _prp_json=$(pi auth check --provider "$_prp_p" --no-refresh --json 2>/dev/null) || true
    case "$_prp_json" in
      *'"status":"ready"'* | *'"status": "ready"'*) _prp_out="$_prp_out $_prp_p" ;;
    esac
  done
  printf '%s' "${_prp_out# }"
}

_pi_auth() {
  step "pi auth"

  if ! command -v pi >/dev/null 2>&1; then
    warn "pi CLI not found; install it first (npm i -g $PD_PI_PACKAGE) and re-run onboarding"
    PI_AUTH_STATUS="none"
    return 0
  fi

  _pi_ready=$(_pi_ready_providers)
  if [ -n "$_pi_ready" ]; then
    info "pi credentials found for:$_pi_ready"
    if [ "$(printf '%s' "$_pi_ready" | wc -w | tr -d ' ')" = "1" ]; then
      PI_PROVIDER=$_pi_ready
    else
      ask "Which provider should pideck use? [$_pi_ready] " _pi_choice
      _pi_choice=$(printf '%s' "$_pi_choice" | tr '[:upper:]' '[:lower:]')
      if [ -z "$_pi_choice" ]; then
        PI_PROVIDER=$(printf '%s' "$_pi_ready" | awk '{print $1}')
      else
        case " $_pi_ready " in
          *" $_pi_choice "*) PI_PROVIDER=$_pi_choice ;;
          *) warn "unknown provider '$_pi_choice'; using $(printf '%s' "$_pi_ready" | awk '{print $1}')" &&
            PI_PROVIDER=$(printf '%s' "$_pi_ready" | awk '{print $1}') ;;
        esac
      fi
    fi
    PI_AUTH_STATUS="ready"
    ok "pi auth ready (provider: $PI_PROVIDER)"
    return 0
  fi

  info "no pi credentials found yet — pi's own login flow will be used"
  info "inside pi do:"
  info "  1. run /login, pick a provider and authenticate"
  info "  2. (optional) run /model and press Ctrl+S to save your startup default"
  info "  3. quit pi with /exit — onboarding continues automatically"
  if [ "$PD_DRY_RUN" = "1" ]; then
    printf "[dry-run] launch 'pi' for interactive /login\n"
    PI_AUTH_STATUS="none"
    return 0
  fi
  if [ "$PD_NONINTERACTIVE" = "1" ]; then
    warn "non-interactive mode; skipping pi login (re-run 'pideck onboard' to finish)"
    PI_AUTH_STATUS="none"
    return 0
  fi
  ask "Press Enter to launch pi… " _pi_go
  # Hand the terminal to pi's own TUI for /login — no auth logic here.
  pi </dev/tty >/dev/tty 2>&1 || warn "pi exited with an error"
  _pi_ready=$(_pi_ready_providers)
  if [ -n "$_pi_ready" ]; then
    PI_AUTH_STATUS="ready"
    PI_PROVIDER=$(printf '%s' "$_pi_ready" | awk '{print $1}')
    ok "pi auth ready (provider: $PI_PROVIDER)"
  else
    warn "still no pi credentials detected; re-run 'pideck onboard' when ready"
    PI_AUTH_STATUS="none"
  fi
}

# ---------------------------------------------------------------------------
# model selection
# ---------------------------------------------------------------------------
_pi_settings_value() { # _pi_settings_value <key> -> value from ~/.pi/agent/settings.json
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$PD_PI_DIR/settings.json" 2>/dev/null | tail -n 1
}

_pi_model_select() {
  step "model selection"
  _pi_saved_model=$(_pi_settings_value defaultModel)
  _pi_saved_provider=$(_pi_settings_value defaultProvider)
  if [ -n "$_pi_saved_model" ]; then
    info "pi startup default: ${_pi_saved_provider:-?}/${_pi_saved_model}"
    if ask_yn "Use it for pideck agents?" y; then
      PI_PROVIDER=${_pi_saved_provider:-$PI_PROVIDER}
      PD_MODEL="$PI_PROVIDER/$_pi_saved_model"
      ok "model: $PD_MODEL (pi's own startup default)"
      return 0
    fi
  fi

  if [ "$PD_NONINTERACTIVE" = "1" ] || [ "$PD_DRY_RUN" = "1" ]; then
    if [ "$PD_DRY_RUN" = "1" ]; then printf "[dry-run] interactive model selection via 'pi --list-models'\n"; fi
    warn "no model selected; re-run 'pideck onboard' to pick one"
    return 0
  fi

  while :; do
    ask "Filter models by search term (Enter for the full list): " _pi_term
    if [ -n "$_pi_term" ]; then
      pi --list-models "$_pi_term" > "$PD_HOME/state/.models" 2>/dev/null || { warn "pi --list-models failed; is pi authed?"; return 0; }
    else
      pi --list-models > "$PD_HOME/state/.models" 2>/dev/null || { warn "pi --list-models failed; is pi authed?"; return 0; }
    fi
    _pi_list=$(tail -n +2 "$PD_HOME/state/.models" | head -n 40)
    if [ -z "$_pi_list" ]; then
      warn "no models matched; try another term"
      continue
    fi
    printf '%s\n' "$_pi_list" | nl -ba -w3 -s'  '
    ask "Pick a number (or Enter to search again): " _pi_pick
    [ -z "$_pi_pick" ] && continue
    _pi_row=$(printf '%s\n' "$_pi_list" | sed -n "${_pi_pick}p")
    if [ -z "$_pi_row" ]; then
      warn "invalid choice"
      continue
    fi
    PI_PROVIDER=$(printf '%s' "$_pi_row" | awk '{print $1}')
    PI_MODEL_ID=$(printf '%s' "$_pi_row" | awk '{print $2}')
    PD_MODEL="$PI_PROVIDER/$PI_MODEL_ID"
    ok "model: $PD_MODEL"
    info "tip: press Ctrl+S on a model inside pi (/model) to save it as pi's startup default"
    return 0
  done
}

# ---------------------------------------------------------------------------
# primary gh auth
# ---------------------------------------------------------------------------
_read_pat_from_dotenv() {
  _rp_file="$HOME/.env"
  [ -f "$_rp_file" ] || return 0
  # Only ever extract the two known token lines — never source ~/.env.
  sed -n 's/^[[:space:]]*\(export[[:space:]]\+\)\?\(GH_TOKEN\|GITHUB_TOKEN\)=//p' "$_rp_file" |
    tail -n 1 |
    sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

_gh_setup() {
  step "primary gh auth"
  command -v gh >/dev/null 2>&1 || die "gh CLI not found — the installer should have installed it; re-run bootstrap.sh"

  GH_TOKEN_SOURCE="none"
  if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
    _gh_pat=$(_read_pat_from_dotenv)
    if [ -n "$_gh_pat" ]; then
      GH_TOKEN=$_gh_pat
      export GH_TOKEN
      GH_TOKEN_SOURCE="$HOME/.env"
      ok "using PAT from ~/.env (GH_TOKEN)"
    fi
  else
    GH_TOKEN_SOURCE="environment"
    ok "using GH_TOKEN/GITHUB_TOKEN already present in the environment"
  fi

  if [ "$PD_DRY_RUN" = "1" ]; then
    printf "[dry-run] gh auth status (or 'gh auth login' when unauthenticated)\n"
    GH_AUTH_STATUS="unknown"
    return 0
  fi

  if gh auth status >/dev/null 2>&1; then
    GH_USER=$(gh api user --jq .login 2>/dev/null || :)
    GH_AUTH_STATUS=ready
    ok "gh authenticated${GH_USER:+ as $GH_USER}"
    return 0
  fi

  if [ "$PD_NONINTERACTIVE" = "1" ]; then
    warn "gh not authenticated; re-run 'pideck onboard' to complete gh auth"
    GH_AUTH_STATUS=none
    return 0
  fi

  info "no GitHub auth found — launching gh's own login flow"
  gh auth login </dev/tty >/dev/tty 2>&1 || warn "gh auth login did not complete"
  if gh auth status >/dev/null 2>&1; then
    GH_USER=$(gh api user --jq .login 2>/dev/null || :)
    GH_AUTH_STATUS=ready
    ok "gh authenticated${GH_USER:+ as $GH_USER}"
  else
    warn "gh still not authenticated; re-run 'pideck onboard' later"
    GH_AUTH_STATUS=none
  fi
}

# ---------------------------------------------------------------------------
# review account (required)
# ---------------------------------------------------------------------------
_review_device_login() {
  _rd_dir="$PD_HOME/state/gh-review"
  info "sign in as the REVIEW account in the browser — a one-time code is shown next"
  _rd_rc=0
  if [ -t 0 ]; then
    GH_CONFIG_DIR="$_rd_dir" gh auth login --web --git-protocol https || _rd_rc=1
  elif ! GH_CONFIG_DIR="$_rd_dir" gh auth login --web --git-protocol https </dev/tty 2>/dev/null; then
    # No controlling terminal (service/CI environments): let gh try on its
    # own stdin — it fails cleanly there and onboarding falls back to the PAT.
    GH_CONFIG_DIR="$_rd_dir" gh auth login --web --git-protocol https || _rd_rc=1
  fi
  if [ "$_rd_rc" != "0" ]; then
    warn "gh's device sign-in did not complete"
    return 1
  fi
  REVIEW_TOKEN=$(GH_CONFIG_DIR="$_rd_dir" gh auth token 2>/dev/null) || REVIEW_TOKEN=""
  if [ -z "$REVIEW_TOKEN" ]; then
    warn "could not read the review token from gh"
    return 1
  fi
  # Read the account as the new token itself: an ambient GH_TOKEN would
  # otherwise resolve to the primary account.
  REVIEW_USER=$(GH_TOKEN="$REVIEW_TOKEN" gh api user --jq .login 2>/dev/null) || REVIEW_USER=""
  if [ -z "$REVIEW_USER" ]; then
    warn "could not resolve the review account's username"
    return 1
  fi
  return 0
}

_verify_review_account() {
  [ -n "$REVIEW_USER" ] || return 1
  [ -n "$REVIEW_TOKEN" ] || return 1
  _rv_out=$(GH_TOKEN="$REVIEW_TOKEN" gh auth status 2>&1) || {
    warn "gh rejected the review token: $_rv_out"
    return 1
  }
  _rv_login=$(GH_TOKEN="$REVIEW_TOKEN" gh api user --jq .login 2>/dev/null) || {
    warn "could not resolve the review token's account"
    return 1
  }
  _rv_user_l=$(printf '%s' "$REVIEW_USER" | tr '[:upper:]' '[:lower:]')
  _rv_login_l=$(printf '%s' "$_rv_login" | tr '[:upper:]' '[:lower:]')
  if [ "$_rv_user_l" != "$_rv_login_l" ]; then
    warn "the review token belongs to '$_rv_login', not '$REVIEW_USER'"
    return 1
  fi
  return 0
}

_review_account() {
  step "review account (required)"
  info "the review leg files real PR reviews as a SECOND GitHub account —"
  info "with a single account the loop has no review leg at all"
  info "easiest: gh's device sign-in (one-time code at github.com/login/device)"
  info "fallback: create a PAT for that account (github.com/settings/tokens)"

  while :; do
    if [ "$PD_DRY_RUN" = "1" ]; then
      printf '[dry-run] device sign-in under %s/state/gh-review, or prompt for review account username + PAT\n' "$PD_HOME"
      REVIEW_STATUS=dry-run
      return 0
    fi
    if [ -n "${PD_REVIEW_USER:-}" ] && [ -n "${PD_REVIEW_TOKEN:-}" ]; then
      REVIEW_USER=$PD_REVIEW_USER
      REVIEW_TOKEN=$PD_REVIEW_TOKEN
      REVIEW_METHOD=pat
    elif [ "$PD_NONINTERACTIVE" = "1" ] && [ "${PD_REVIEW_DEVICE:-0}" != "1" ]; then
      warn "review account required but not provided (set PD_REVIEW_USER + PD_REVIEW_TOKEN)"
      REVIEW_STATUS=none
      return 1
    else
      if [ "${PD_REVIEW_DEVICE:-0}" = "1" ] || ask_yn "Sign in with gh's device flow (one-time code in the browser)?" y; then
        if _review_device_login && _verify_review_account; then
          REVIEW_STATUS=ready
          REVIEW_METHOD=device
          ok "review account verified: $REVIEW_USER"
          return 0
        fi
        warn "device sign-in did not produce a verified account — falling back to the PAT form"
      fi
      ask "review account username: " REVIEW_USER
      ask "review account PAT: " REVIEW_TOKEN
      if [ "$PD_NONINTERACTIVE" = "1" ] && [ -z "$REVIEW_USER" ] && [ -z "$REVIEW_TOKEN" ]; then
        warn "review account required but not provided (set PD_REVIEW_USER + PD_REVIEW_TOKEN, or run interactively)"
        REVIEW_STATUS=none
        return 1
      fi
    fi

    if [ "$PD_DRY_RUN" != "1" ] && _verify_review_account; then
      REVIEW_STATUS=ready
      ok "review account verified: $REVIEW_USER"
      return 0
    fi

    # Env-supplied values get exactly one shot; interactive answers retry.
    if [ -n "${PD_REVIEW_USER:-}" ] && [ -n "${PD_REVIEW_TOKEN:-}" ]; then
      warn "review account verification failed — re-run 'pideck onboard' with correct values"
      REVIEW_STATUS=none
      return 1
    fi
    if [ "$PD_DRY_RUN" != "1" ]; then
      warn "verification failed — check the username and token, then try again"
      REVIEW_USER=""
      REVIEW_TOKEN=""
    fi
  done
}

# ---------------------------------------------------------------------------
# Record results
# ---------------------------------------------------------------------------
_write_results() {
  step "recording onboarding results"
  run mkdir -p "$PD_HOME/state"
  env_set "$PD_HOME/env" PIDECK_MODEL "${PD_MODEL:-}"
  if [ "$PD_DRY_RUN" = "1" ]; then
    printf "[dry-run] write %s/settings.json (review account + model per persona, chmod 600)\n" "$PD_HOME"
    printf "[dry-run] write %s/onboarding.json and state/onboard-complete\n" "$PD_HOME"
    return 0
  fi
  # The daemon's settings file only exists once the required review account
  # is verified — an incomplete onboarding must not look configured. The
  # shape is the shared GlobalSettingsSchema (packages/shared/src/settings.ts):
  # install/test/fixtures/settings.json is the byte-identical example both
  # the shell test and the daemon test read.
  if [ "${REVIEW_STATUS:-none}" = "ready" ]; then
    if [ -n "${PD_MODEL:-}" ]; then
      _model_value="\"$(json_str "$PD_MODEL")\""
    else
      _model_value=null
    fi
    {
      printf '{\n'
      printf '  "reviewAccount": {\n'
      printf '    "username": "%s",\n' "$(json_str "$REVIEW_USER")"
      printf '    "token": "%s"\n' "$(json_str "$REVIEW_TOKEN")"
      printf '  },\n'
      printf '  "modelByPersona": {\n'
      printf '    "global": %s,\n' "$_model_value"
      printf '    "orchestrator": %s,\n' "$_model_value"
      printf '    "worker": %s,\n' "$_model_value"
      printf '    "reviewer": %s\n' "$_model_value"
      printf '  }\n'
      printf '}\n'
    } > "$PD_HOME/settings.json"
    chmod 600 "$PD_HOME/settings.json"
    ok "wrote $PD_HOME/settings.json (review account + model per persona; read by the daemon)"
  fi
  {
    printf '{\n'
    printf '  "onboardedAt": "%s",\n' "$(iso_now)"
    printf '  "pi": {\n'
    printf '    "authStatus": "%s",\n' "$(json_str "${PI_AUTH_STATUS:-none}")"
    printf '    "provider": "%s",\n' "$(json_str "${PI_PROVIDER:-}")"
    printf '    "model": "%s",\n' "$(json_str "${PD_MODEL:-}")"
    printf '    "readyProviders": "%s"\n' "$(json_str "${_pi_ready:-}")"
    printf '  },\n'
    printf '  "gh": {\n'
    printf '    "authStatus": "%s",\n' "$(json_str "${GH_AUTH_STATUS:-none}")"
    printf '    "user": "%s",\n' "$(json_str "${GH_USER:-}")"
    printf '    "tokenSource": "%s"\n' "$(json_str "${GH_TOKEN_SOURCE:-none}")"
    printf '  },\n'
    printf '  "review": {\n'
    printf '    "status": "%s",\n' "$(json_str "${REVIEW_STATUS:-none}")"
    printf '    "method": "%s",\n' "$(json_str "${REVIEW_METHOD:-}")"
    printf '    "username": "%s"\n' "$(json_str "${REVIEW_USER:-}")"
    printf '  }\n'
    printf '}\n'
  } > "$PD_HOME/onboarding.json"
  if [ "${REVIEW_STATUS:-none}" = "ready" ]; then
    : > "$PD_HOME/state/onboard-complete"
  fi
  ok "wrote $PD_HOME/onboarding.json (remembered across restarts)"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
  DO_PI=1
  DO_GH=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) PD_DRY_RUN=1 ;;
      --noninteractive) PD_NONINTERACTIVE=1 ;;
      --skip-pi) DO_PI=0 ;;
      --skip-gh) DO_GH=0 ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done

  detect_os
  run mkdir -p "$PD_HOME" "$PD_HOME/state"

  info "PiDeck guided onboarding"
  info "results are stored in $PD_HOME and survive restarts"

  PI_AUTH_STATUS="none"
  PI_PROVIDER=""
  PD_MODEL=""
  _pi_ready=""
  GH_AUTH_STATUS="none"
  GH_USER=""
  GH_TOKEN_SOURCE="none"
  REVIEW_USER=""
  REVIEW_TOKEN=""
  REVIEW_METHOD=""
  REVIEW_STATUS="none"

  if [ "$DO_PI" = "1" ]; then
    _pi_auth
    [ "$PI_AUTH_STATUS" = "ready" ] && _pi_model_select
  fi
  if [ "$DO_GH" = "1" ]; then
    _gh_setup
  fi
  _review_account
  _write_results

  printf '\n'
  info "onboarding summary:"
  printf '  pi auth:        %s%s%s\n' "${PI_AUTH_STATUS:-none}" \
    "${PI_PROVIDER:+ ($PI_PROVIDER}" "${PI_PROVIDER:+)}"
  printf '  pi model:       %s\n' "${PD_MODEL:-(not selected)}"
  printf '  gh auth:        %s%s\n' "${GH_AUTH_STATUS:-none}" "${GH_USER:+ ($GH_USER)}"
  printf '  review account: %s%s\n' "${REVIEW_STATUS:-none}" "${REVIEW_USER:+ ($REVIEW_USER)}"

  # The review account is required: onboarding must not end "complete"
  # without a verified one.
  if [ "${REVIEW_STATUS:-none}" != "ready" ] && [ "${REVIEW_STATUS:-none}" != "dry-run" ]; then
    printf '\n'
    warn "NEXT STEP — onboarding is incomplete: the review account is missing or unverified"
    info "  run:  pideck onboard   (set PD_REVIEW_USER + PD_REVIEW_TOKEN for noninteractive runs)"
    exit 1
  fi
  if [ "${PI_AUTH_STATUS:-none}" != "ready" ] || [ "${GH_AUTH_STATUS:-none}" != "ready" ]; then
    printf '\n'
    warn "onboarding incomplete (pi and/or gh auth missing) — re-run 'pideck onboard' to finish"
  fi
  info "re-run anytime with: pideck onboard"
}

main "$@"
