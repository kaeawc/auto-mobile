#!/usr/bin/env bats
#
# Guards issue #4124: `ios-xctest-runner-simulator-tests` used to install FFmpeg
# *inside* the videoRecording test step:
#
#     - name: "Run videoRecording MP4 integration test"
#       timeout-minutes: 10
#       run: |
#         brew list ffmpeg >/dev/null 2>&1 || brew install ffmpeg
#         ./scripts/ios/video-recording-start-stop-integration.sh
#
# That charged a cold `brew install ffmpeg` (a large formula tree) against the
# step's own 10-minute cap AND against the test's internal 180s budget — and that
# step is a known intermittent timeout. The fix backgrounds the install with the
# existing XcodeGen/xcpretty fan-out so it overlaps the simulator boot, and
# re-syncs with a `wait` barrier before the test.
#
# This test pins the invariant in both directions: the install must be
# backgrounded and start before the boot, the barrier must precede the consumer,
# and the test step must no longer carry the install inline.

WORKFLOW=".github/workflows/pull_request.yml"

# Line number of the first line matching a fixed string, or empty when absent.
# The pattern is passed with -e because one of the searched strings begins with
# "-" (the `- wait:` barrier), which every grep implementation would otherwise
# parse as an option.
line_of() {
  grep -n -F -m1 -e "$1" "$WORKFLOW" 2>/dev/null | cut -d: -f1
}

@test "an Install ffmpeg step exists, backgrounded, with the install-ffmpeg id" {
  run grep -A3 -F 'name: "Install ffmpeg"' "$WORKFLOW"
  [ "$status" -eq 0 ]
  [[ "$output" == *"background: true"* ]]
  [[ "$output" == *"id: install-ffmpeg"* ]]
}

@test "the ffmpeg install starts before the Xcode 26.5 simulator boot" {
  # AC1: the install must run *concurrently with* the boot, which means its step
  # has to appear earlier in the step list than the boot it overlaps.
  install_line="$(line_of 'name: "Install ffmpeg"')"
  boot_line="$(line_of 'name: "Boot iOS Simulator (Xcode 26.5)"')"

  [ -n "$install_line" ] || { echo "Install ffmpeg step not found" >&2; false; }
  [ -n "$boot_line" ] || { echo "Xcode 26.5 boot step not found" >&2; false; }

  if [ "$install_line" -ge "$boot_line" ]; then
    echo "Install ffmpeg (line $install_line) must precede the 26.5 boot (line $boot_line)" >&2
    false
  fi
}

@test "a wait barrier for install-ffmpeg precedes the videoRecording test" {
  # AC1: without the barrier the test could start before ffmpeg finished
  # installing — the exact failure the background step would otherwise introduce.
  wait_line="$(line_of '- wait: install-ffmpeg')"
  test_line="$(line_of 'name: "Run videoRecording MP4 integration test"')"

  [ -n "$wait_line" ] || { echo "'- wait: install-ffmpeg' barrier not found" >&2; false; }
  [ -n "$test_line" ] || { echo "videoRecording test step not found" >&2; false; }

  if [ "$wait_line" -ge "$test_line" ]; then
    echo "wait barrier (line $wait_line) must precede the video test (line $test_line)" >&2
    false
  fi
}

@test "the videoRecording test step no longer installs ffmpeg inline" {
  # AC2: the step's 10-minute budget must cover the test alone. Extract the step
  # block (from its name up to the next step marker) and assert it is brew-free.
  block="$(awk '
    /name: "Run videoRecording MP4 integration test"/ { inblock = 1; next }
    inblock && /^      - (name|wait|uses):/ { exit }
    inblock { print }
  ' "$WORKFLOW")"

  [ -n "$block" ] || { echo "videoRecording test step block not found" >&2; false; }

  if echo "$block" | grep -q "brew"; then
    echo "videoRecording test step still installs ffmpeg inline:" >&2
    echo "$block" >&2
    false
  fi

  # And it must still actually run the integration script.
  echo "$block" | grep -q "video-recording-start-stop-integration.sh"
}
