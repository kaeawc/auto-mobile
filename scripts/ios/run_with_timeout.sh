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
# This file is meant to be sourced; it only defines a function.

run_with_timeout() {
  local secs="$1"
  shift
  if command -v timeout > /dev/null 2>&1; then
    timeout "${secs}" "$@"
  elif command -v gtimeout > /dev/null 2>&1; then
    gtimeout "${secs}" "$@"
  else
    "$@" &
    local cmd_pid=$!
    (
      sleep "${secs}"
      kill -0 "${cmd_pid}" 2> /dev/null && kill "${cmd_pid}" 2> /dev/null
    ) &
    local watcher_pid=$!
    local status=0
    wait "${cmd_pid}" 2> /dev/null || status=$?
    kill "${watcher_pid}" 2> /dev/null || true
    wait "${watcher_pid}" 2> /dev/null || true
    return "${status}"
  fi
}
