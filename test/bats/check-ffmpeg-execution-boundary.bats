#!/usr/bin/env bats

SCRIPT="scripts/check-ffmpeg-execution-boundary.sh"
FIXTURE="src/utils/FfmpegBoundaryFixture.ts"

teardown() {
  rm -f "$FIXTURE"
}

@test "allows FfmpegClient to own FFmpeg execution" {
  run bash "$SCRIPT"

  [ "$status" -eq 0 ]
  [[ "$output" == *"no direct production FFmpeg invocations"* ]]
}

@test "rejects a direct FFmpeg spawn outside the owner" {
  printf '%s\n' 'import { spawn } from "node:child_process"; spawn("ffmpeg", ["-version"]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"FfmpegBoundaryFixture.ts"* ]]
}

@test "rejects an aliased FFmpeg binary passed to a child-process launcher" {
  printf '%s\n' 'import { spawn } from "node:child_process"; const binary = "ffmpeg"; spawn(binary, ["-version"]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"FfmpegBoundaryFixture.ts"* ]]
}

@test "rejects an environment-resolved FFmpeg binary passed to a child-process launcher" {
  printf '%s\n' 'import { spawn } from "node:child_process"; const binary = process.env.AUTOMOBILE_FFMPEG ?? "ffmpeg"; spawn(binary, ["-version"]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"FfmpegBoundaryFixture.ts"* ]]
}

@test "rejects a destructured CommonJS child-process launcher" {
  printf '%s\n' 'const { spawn } = require("node:child_process"); spawn("ffmpeg", ["-version"]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"FfmpegBoundaryFixture.ts"* ]]
}

@test "rejects a shell-form FFmpeg execution" {
  printf '%s\n' 'import { exec } from "node:child_process"; exec("ffmpeg -version");' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"FfmpegBoundaryFixture.ts"* ]]
}

@test "rejects FFmpeg behind a shell wrapper" {
  printf '%s\n' 'import { spawn } from "node:child_process"; spawn("/bin/sh", ["-c", "ffmpeg -version"]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"FfmpegBoundaryFixture.ts"* ]]
}

@test "rejects Bun spawn with an FFmpeg binary" {
  printf '%s\n' 'Bun.spawn(["ffmpeg", "-version"]);' > "$FIXTURE"

  run bash "$SCRIPT"

  [ "$status" -eq 1 ]
  [[ "$output" == *"FfmpegBoundaryFixture.ts"* ]]
}
