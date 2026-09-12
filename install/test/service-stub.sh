# shellcheck shell=sh
#
# Fake installed lib/service.sh used by install/test/*.sh: records service
# calls as stdout markers instead of touching launchd/systemd, and prints a
# fixed webapp URL.
svc_start() { printf 'SVC start\n'; }
svc_stop() { printf 'SVC stop\n'; }
svc_restart() { printf 'SVC restart\n'; }
svc_status() { printf 'SVC status\n'; }
webapp_url() { printf 'http://127.0.0.1:8321'; }
