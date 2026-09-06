#!/bin/sh
# shellcheck shell=sh disable=SC1091
#
# agentsKISS guided onboarding.
#
#  1. pi auth flow + model selection — shells out to the pi CLI's own
#     auth (`pi auth check`, interactive `/login` in the pi TUI); we never
#     reimplement auth, we only detect it and launch pi when needed.
#  2. gh CLI setup — uses a PAT from ~/.env (GH_TOKEN/GITHUB_TOKEN) when
#     present, else walks through `gh auth login`; verifies the grants are
#     sufficient for repo creation and records the result.
#
# Results are written to ~/.agentskiss/onboarding.json (recorded for the
# repo-connect flow) and ~/.agentskiss/env (AGENTSKISS_MODEL for the
# daemon), both remembered across restarts.
#
# Usage:
#   install/onboard.sh [--dry-run] [--noninteractive] [--skip-pi] [--skip-gh]
#
# Also reachable post-install via: agentskiss onboard

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$script_dir/lib/common.sh"
. "$script_dir/lib/deps.sh"

AK_PI_PROVIDERS="anthropic openai google google-vertex openai-codex openrouter github-copilot xai groq mistral amazon-bedrock zai nvidia"

usage() {
  cat <<'EOF'
Usage: onboard.sh [--dry-run] [--noninteractive] [--skip-pi] [--skip-gh]

Guided onboarding for agentsKISS: pi auth + model selection, then gh auth.
Results are recorded under ~/.agentskiss/ and remembered across restarts.
EOF
}

# ---------------------------------------------------------------------------
# pi auth
# ---------------------------------------------------------------------------
_pi_ready_providers() {
  _prp_out=""
  for _prp_p in $AK_PI_PROVIDERS; do
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
    warn "pi CLI not found; install it first (npm i -g $AK_PI_NPM_PACKAGE) and re-run onboarding"
    PI_AUTH_STATUS="none"
    return 0
  fi

  _pi_ready=$(_pi_ready_providers)
  if [ -n "$_pi_ready" ]; then
    info "pi credentials found for:$_pi_ready"
    if [ "$(printf '%s' "$_pi_ready" | wc -w | tr -d ' ')" = "1" ]; then
      PI_PROVIDER=$_pi_ready
    else
      ask "Which provider should agentskiss use? [$_pi_ready] " _pi_choice
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
  if [ "$AK_DRY_RUN" = "1" ]; then
    printf "[dry-run] launch 'pi' for interactive /login\n"
    PI_AUTH_STATUS="none"
    return 0
  fi
  if [ "$AK_NONINTERACTIVE" = "1" ]; then
    warn "non-interactive mode; skipping pi login (re-run 'agentskiss onboard' later)"
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
    warn "still no pi credentials detected; re-run 'agentskiss onboard' when ready"
    PI_AUTH_STATUS="none"
  fi
}

# ---------------------------------------------------------------------------
# model selection
# ---------------------------------------------------------------------------
_pi_settings_value() { # _pi_settings_value <key> -> value from ~/.pi/agent/settings.json
  sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$AK_PI_DIR/settings.json" 2>/dev/null | tail -n 1
}

_pi_model_select() {
  step "model selection"
  _pi_saved_model=$(_pi_settings_value defaultModel)
  _pi_saved_provider=$(_pi_settings_value defaultProvider)
  if [ -n "$_pi_saved_model" ]; then
    info "pi startup default: ${_pi_saved_provider:-?}/${_pi_saved_model}"
    if ask_yn "Use it for agentskiss workers?" y; then
      PI_PROVIDER=${_pi_saved_provider:-$PI_PROVIDER}
      PI_MODEL_ID=$_pi_saved_model
      AK_MODEL="$PI_PROVIDER/$PI_MODEL_ID"
      ok "model: $AK_MODEL (pi's own startup default)"
      return 0
    fi
  fi

  if [ "$AK_NONINTERACTIVE" = "1" ] || [ "$AK_DRY_RUN" = "1" ]; then
    if [ "$AK_DRY_RUN" = "1" ]; then printf "[dry-run] interactive model selection via 'pi --list-models'\n"; fi
    warn "no model selected; re-run 'agentskiss onboard' to pick one"
    return 0
  fi

  while :; do
    ask "Filter models by search term (Enter for the full list): " _pi_term
    if [ -n "$_pi_term" ]; then
      pi --list-models "$_pi_term" > "$AK_HOME/state/.models" 2>/dev/null || { warn "pi --list-models failed; is pi authed?"; return 0; }
    else
      pi --list-models > "$AK_HOME/state/.models" 2>/dev/null || { warn "pi --list-models failed; is pi authed?"; return 0; }
    fi
    _pi_list=$(tail -n +2 "$AK_HOME/state/.models" | head -n 40)
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
    AK_MODEL="$PI_PROVIDER/$PI_MODEL_ID"
    ok "model: $AK_MODEL"
    info "tip: press Ctrl+S on a model inside pi (/model) to save it as pi's startup default"
    return 0
  done
}

# ---------------------------------------------------------------------------
# gh CLI setup
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
  step "gh CLI setup"
  ensure_gh

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

  if _gh_status_out=$(gh auth status 2>&1); then
    # gh 2.x: "  - Token scopes: 'gist', 'repo', ..." (older: "- Scopes: ...")
    GH_SCOPES=$(printf '%s' "$_gh_status_out" | grep -iE '^[[:space:]]*[-*]?[[:space:]]*(Token[[:space:]]+)?Scopes:' | head -n 1 | sed 's/.*[Ss]copes:[[:space:]]*//' | tr -d " '")
    GH_USER=$(gh api user --jq .login 2>/dev/null || printf '%s' "$_gh_status_out" | sed -n 's/.*account \([^ ]*\).*/\1/p' | head -n 1)
    GH_AUTH_STATUS=ready
    ok "gh authenticated${GH_USER:+ as $GH_USER}"
  else
    GH_USER=""
    GH_SCOPES=""
    if [ "$AK_DRY_RUN" = "1" ] || [ "$AK_NONINTERACTIVE" = "1" ]; then
      warn "gh not authenticated; re-run 'agentskiss onboard' to complete gh auth"
      GH_AUTH_STATUS=none
      return 0
    fi
    info "no GitHub auth found — launching gh's own login flow"
    gh auth login </dev/tty >/dev/tty 2>&1 || warn "gh auth login did not complete"
    if gh auth status >/dev/null 2>&1; then
      GH_SCOPES=$(gh auth status 2>&1 | grep -iE '^[[:space:]]*[-*]?[[:space:]]*(Token[[:space:]]+)?Scopes:' | head -n 1 | sed 's/.*[Ss]copes:[[:space:]]*//' | tr -d " '")
      GH_USER=$(gh api user --jq .login 2>/dev/null || :)
      GH_AUTH_STATUS=ready
      ok "gh authenticated${GH_USER:+ as $GH_USER}"
    else
      warn "gh still not authenticated; re-run 'agentskiss onboard' later"
      GH_AUTH_STATUS=none
      return 0
    fi
  fi

  # Repo creation needs the 'repo' scope; record it for the repo-connect flow.
  case ",$GH_SCOPES," in
    *,repo,* | *",repo"*) GH_CAN_CREATE_REPO=true ;;
    *)
      if [ -n "$GH_SCOPES" ]; then
        warn "gh grants do not include 'repo' (scopes: $GH_SCOPES) — creating new repos will need a re-login with repo scope"
      else
        warn "could not determine gh scopes; repo-create permission unknown"
      fi
      GH_CAN_CREATE_REPO=false
      ;;
  esac
  ok "gh repo-create permission: $GH_CAN_CREATE_REPO (scopes: ${GH_SCOPES:-unknown})"
}

# ---------------------------------------------------------------------------
# Record results
# ---------------------------------------------------------------------------
_write_results() {
  step "recording onboarding results"
  run mkdir -p "$AK_HOME/state"
  env_set "$AK_HOME/env" AGENTSKISS_MODEL "${AK_MODEL:-}"
  if [ "$AK_DRY_RUN" = "1" ]; then
    printf "[dry-run] write %s/onboarding.json and state/onboard-complete\n" "$AK_HOME"
    return 0
  fi
  {
    printf '{\n'
    printf '  "onboardedAt": "%s",\n' "$(iso_now)"
    printf '  "pi": {\n'
    printf '    "authStatus": "%s",\n' "$(json_str "${PI_AUTH_STATUS:-none}")"
    printf '    "provider": "%s",\n' "$(json_str "${PI_PROVIDER:-}")"
    printf '    "model": "%s",\n' "$(json_str "${AK_MODEL:-}")"
    printf '    "readyProviders": "%s"\n' "$(json_str "${_pi_ready:-}")"
    printf '  },\n'
    printf '  "gh": {\n'
    printf '    "authStatus": "%s",\n' "$(json_str "${GH_AUTH_STATUS:-none}")"
    printf '    "user": "%s",\n' "$(json_str "${GH_USER:-}")"
    printf '    "scopes": "%s",\n' "$(json_str "${GH_SCOPES:-}")"
    printf '    "canCreateRepo": %s,\n' "${GH_CAN_CREATE_REPO:-false}"
    printf '    "tokenSource": "%s"\n' "$(json_str "${GH_TOKEN_SOURCE:-none}")"
    printf '  }\n'
    printf '}\n'
  } > "$AK_HOME/onboarding.json"
  : > "$AK_HOME/state/onboard-complete"
  ok "wrote $AK_HOME/onboarding.json (remembered across restarts)"
}

# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
main() {
  DO_PI=1
  DO_GH=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --dry-run) AK_DRY_RUN=1 ;;
      --noninteractive) AK_NONINTERACTIVE=1 ;;
      --skip-pi) DO_PI=0 ;;
      --skip-gh) DO_GH=0 ;;
      -h | --help) usage; exit 0 ;;
      *) die "unknown option: $1 (see --help)" ;;
    esac
    shift
  done

  detect_os
  run mkdir -p "$AK_HOME" "$AK_HOME/state"

  info "agentsKISS guided onboarding"
  info "results are stored in $AK_HOME and survive restarts"

  PI_AUTH_STATUS="none"
  PI_PROVIDER=""
  AK_MODEL=""
  _pi_ready=""
  GH_AUTH_STATUS="none"
  GH_USER=""
  GH_SCOPES=""
  GH_CAN_CREATE_REPO=false
  GH_TOKEN_SOURCE="none"

  if [ "$DO_PI" = "1" ]; then
    _pi_auth
    [ "$PI_AUTH_STATUS" = "ready" ] && _pi_model_select
  fi
  if [ "$DO_GH" = "1" ]; then
    _gh_setup
  fi

  _write_results

  printf '\n'
  info "onboarding summary:"
  printf '  pi auth:     %s%s%s\n' "${PI_AUTH_STATUS:-none}" \
    "${PI_PROVIDER:+ ($PI_PROVIDER}" "${PI_PROVIDER:+)}"
  printf '  pi model:    %s\n' "${AK_MODEL:-(not selected)}"
  printf '  gh auth:     %s%s\n' "${GH_AUTH_STATUS:-none}" "${GH_USER:+ ($GH_USER)}"
  printf '  gh repo-create: %s\n' "${GH_CAN_CREATE_REPO:-false}"
  info "re-run anytime with: agentskiss onboard"
}

main "$@"
