#!/usr/bin/env bash
#
# Bound a command's wall-clock time, portably.
#
# GNU `timeout` is not present on a stock macOS runner and `gtimeout` only
# appears with coreutils, so this falls back to a watchdog subshell. Extracted
# from start-simulator.sh when boot-simulator.sh became the second consumer
# (issue #4095); previously each caller would have carried its own copy.
#
# Usage:  run_with_timeout <seconds> <command> [args...]
# Returns the command's status, or 124 when the watchdog fires (matching
# GNU timeout's convention so callers can distinguish a stall from a failure).
#
# The fallback must reproduce two properties of real `timeout` that a naive
# "background it and kill the pid" watchdog does not give you:
#
#   1. It returns 124 on expiry. Reporting `wait`'s status instead surfaces 143
#      (128+SIGTERM), which a caller cannot tell apart from a command that was
#      signalled for some other reason.
#   2. It signals the whole process group, not just the direct child. A command
#      that leaves a descendant holding stdout keeps a caller's
#      `out="$(run_with_timeout ...)"` blocked past the deadline waiting for EOF
#      on the pipe -- the substitution outlives the process we killed, so the
#      bound silently does not apply. boot-simulator.sh depends on this bound to
#      retry a stalled boot, so that failure mode would defeat the retry.
#
# This file is meant to be sourced; it only defines a function.

run_with_timeout() {
  local secs="$1"
  shift
  if command -v timeout > /dev/null 2>&1; then
    timeout "${secs}" "$@"
  elif command -v gtimeout > /dev/null 2>&1; then
    gtimeout "${secs}" "$@"
  else
    # The watchdog runs in a subshell and so cannot assign to a variable in this
    # scope; a marker file is how it reports back that it fired.
    # Spell the template out rather than using `mktemp -t <prefix>`: BSD mktemp
    # treats the argument as a prefix and appends randomness, but GNU mktemp
    # requires a trailing XXXXXX and hard-errors on a bare prefix, which made
    # every fallback call return 125 on Ubuntu.
    local fired_marker
    fired_marker="$(mktemp "${TMPDIR:-/tmp}/run_with_timeout.XXXXXX")" || return 125

    # Monitor mode puts the child in its own process group (pgid == its pid),
    # which is what lets the group-directed kill below reach descendants.
    # Restore the caller's setting right away so job-control notices do not
    # leak into their output.
    local had_monitor=0
    case "$-" in *m*) had_monitor=1 ;; esac
    set -m
    "$@" &
    local cmd_pid=$!
    if [ "${had_monitor}" -eq 0 ]; then set +m; fi

    (
      sleep "${secs}"
      if kill -0 "${cmd_pid}" 2> /dev/null; then
        printf 'fired' > "${fired_marker}"
        # A negative pid targets the process group. Fall back to the bare pid
        # in case the child never became group leader.
        kill -TERM -"${cmd_pid}" 2> /dev/null || kill -TERM "${cmd_pid}" 2> /dev/null || true
        # Escalate for anything that ignores SIGTERM, so a descendant cannot
        # hold the caller's command substitution open indefinitely.
        sleep 2
        kill -KILL -"${cmd_pid}" 2> /dev/null || kill -KILL "${cmd_pid}" 2> /dev/null || true
      fi
    # The watcher never reports through the caller's output. Closing its output
    # descriptors prevents its sleep child from holding a command substitution
    # open after the timed command has already exited.
    ) > /dev/null 2>&1 3>&- &
    local watcher_pid=$!

    local status=0
    wait "${cmd_pid}" 2> /dev/null || status=$?
    kill "${watcher_pid}" 2> /dev/null || true
    wait "${watcher_pid}" 2> /dev/null || true

    if [ -s "${fired_marker}" ]; then status=124; fi
    rm -f "${fired_marker}"
    return "${status}"
  fi
}
