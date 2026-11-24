#!/usr/bin/env bash
# Launch check for a Linux TalkQTE build under a virtual X display (Xvfb).
# Starts the given executable, waits for a top-level window titled
# "TalkQTE", checks the process is still running, then stops it. It proves
# the app starts and creates its window on this configuration; it does not
# exercise the interface, audio, keys or a meeting.
#
#   scripts/platform/linux-launch-check.sh /path/to/talkqte
#
# Run it under `xvfb-run -a dbus-run-session --` (CI does), so WebKitGTK has a
# display and a session bus. Nothing is captured, stored or sent.
set -euo pipefail

app="${1:?usage: linux-launch-check.sh <executable>}"
wait_seconds="${TALKQTE_LAUNCH_WAIT:-45}"
log="$(mktemp)"

"$app" >"$log" 2>&1 &
pid=$!
cleanup() { kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq "$wait_seconds"); do
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "TalkQTE exited before its window appeared. Output:" >&2
    cat "$log" >&2
    exit 1
  fi
  if xwininfo -root -tree | grep -q '"TalkQTE"'; then
    sleep 3
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "TalkQTE exited right after its window appeared. Output:" >&2
      cat "$log" >&2
      exit 1
    fi
    echo "TalkQTE window found and process still running after 3 s:"
    xwininfo -root -tree | grep '"TalkQTE' || true
    exit 0
  fi
  sleep 1
done

echo "No TalkQTE window after ${wait_seconds} s. Output:" >&2
cat "$log" >&2
xwininfo -root -tree >&2 || true
exit 1
