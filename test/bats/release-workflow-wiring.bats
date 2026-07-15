#!/usr/bin/env bats
#
# Guards the wiring the issue #2745 regression was about: every workflow that
# generates release constants must pass the computed iOS runner SHA256 into the
# script, and the release paths must run the integrity gate before publishing.

@test "release.yml passes runner sha256 into generate-release-constants" {
  grep -q "IOS_CTRL_PROXY_RUNNER_SHA256:" ".github/workflows/release.yml"
  grep -q "runner_sha256" ".github/workflows/release.yml"
}

@test "prepare-release.yml passes runner sha256 into generate-release-constants" {
  grep -q "IOS_CTRL_PROXY_RUNNER_SHA256:" ".github/workflows/prepare-release.yml"
  grep -q "runner_sha256" ".github/workflows/prepare-release.yml"
}

@test "nightly.yml passes runner sha256 into generate-release-constants" {
  grep -q "IOS_CTRL_PROXY_RUNNER_SHA256:" ".github/workflows/nightly.yml"
  grep -q "runner_sha256" ".github/workflows/nightly.yml"
}

@test "nightly.yml includes runner sha256 in generated PR metadata" {
  grep -Fq "RUNNER_CHANGED=\"\${{ steps.check.outputs.runner_changed }}\"" ".github/workflows/nightly.yml"
  grep -q "chore: update CtrlProxy iOS runner SHA256" ".github/workflows/nightly.yml"
  grep -q "chore: update CtrlProxy APK and CtrlProxy iOS runner SHA256" ".github/workflows/nightly.yml"
  grep -q "chore: update CtrlProxy iOS IPA and iOS runner SHA256" ".github/workflows/nightly.yml"
  grep -q "chore: update CtrlProxy APK, iOS IPA, and iOS runner SHA256" ".github/workflows/nightly.yml"
  grep -Fq "| **iOS Runner** |" ".github/workflows/nightly.yml"
}

@test "nightly.yml includes video-server jar sha256 in generated PR metadata (#3833)" {
  # The change detector exposes a video_jar_changed output consumed by the PR body.
  grep -Fq "video_jar_changed=\$VIDEO_JAR_CHANGED" ".github/workflows/nightly.yml"
  grep -Fq "steps.check.outputs.video_jar_changed" ".github/workflows/nightly.yml"
  # Jar-only nightly PRs get their own title, registered in the pull_request.yml
  # sha256-only classifier so heavy CI is still skipped.
  grep -q "chore: update video-server jar SHA256" ".github/workflows/nightly.yml"
  grep -Fq "| **video-server jar** |" ".github/workflows/nightly.yml"
}

@test "pull_request.yml treats iOS runner checksum PR titles as sha256-only" {
  grep -q "chore: update CtrlProxy iOS runner SHA256" ".github/workflows/pull_request.yml"
  grep -q "chore: update CtrlProxy APK and CtrlProxy iOS runner SHA256" ".github/workflows/pull_request.yml"
  grep -q "chore: update CtrlProxy iOS IPA and iOS runner SHA256" ".github/workflows/pull_request.yml"
  grep -q "chore: update CtrlProxy APK, iOS IPA, and iOS runner SHA256" ".github/workflows/pull_request.yml"
}

@test "pull_request.yml treats video-server jar checksum PR titles as sha256-only (#3833)" {
  grep -q "chore: update video-server jar SHA256" ".github/workflows/pull_request.yml"
}

@test "release.yml builds, verifies, and attaches the video-server jar (#3832)" {
  workflow=".github/workflows/release.yml"
  grep -Fq "uses: ./.github/workflows/build-video-server-jar.yml" "$workflow"
  # Verified against the registry via the videojar platform token, then written.
  grep -Fq "/tmp/automobile-video.jar videojar" "$workflow"
  grep -Fq "VIDEO_JAR_SHA256:" "$workflow"
  # Attached to the GitHub release assets.
  grep -Fq "/tmp/automobile-video.jar" "$workflow"
}

@test "prepare-release.yml records the video-server jar checksum (#3832)" {
  workflow=".github/workflows/prepare-release.yml"
  grep -Fq "uses: ./.github/workflows/build-video-server-jar.yml" "$workflow"
  grep -Fq "VIDEO_JAR_SHA256:" "$workflow"
}

@test "build-video-server-jar.yml can verify a reproducible build (#3832)" {
  workflow=".github/workflows/build-video-server-jar.yml"
  grep -Fq "verify-reproducible" "$workflow"
  # The double-build runs once at mint time (prepare-release); release relies on
  # the cross-run registry checksum verification instead, so it does NOT opt in.
  grep -Fq "verify-reproducible: true" ".github/workflows/prepare-release.yml"
  ! grep -Fq "verify-reproducible: true" ".github/workflows/release.yml"
}

@test "pull_request.yml retries GitHub API-backed change classifiers" {
  retry_count="$(sed -n '/name: "Detect Documentation-Only or SHA256-Only Changes"/,/name: "Check for Desktop Core module changes"/p' ".github/workflows/pull_request.yml" | grep -c "retries: 3")"

  [[ "$retry_count" -eq 3 ]]
}

@test "pull_request.yml runs cross-platform TypeScript lint with bash and larger heap" {
  lint_block="$(sed -n '/name: "Run Lint"/,/name: "Run Build"/p' ".github/workflows/pull_request.yml")"

  [[ "$lint_block" == *"shell: bash"* ]]
  [[ "$lint_block" == *"NODE_OPTIONS: \"--max-old-space-size=4096\""* ]]
  [[ "$lint_block" == *"ci-logs/bun-lint-\${{ matrix.os }}.log"* ]]
}

@test "release.yml runs the release-integrity gate" {
  grep -q "verify-release-integrity.sh" ".github/workflows/release.yml"
}

@test "prepare-release.yml runs the release-integrity gate" {
  grep -q "verify-release-integrity.sh" ".github/workflows/prepare-release.yml"
}

@test "build-ctrl-proxy-ios-ipa.yml removes untrusted Homebrew aws tap before installing XcodeGen" {
  workflow=".github/workflows/build-ctrl-proxy-ios-ipa.yml"

  grep -Fq "brew untap aws/tap || true" "$workflow"
  grep -Fq "brew install xcodegen" "$workflow"
  ! grep -Fq "HOMEBREW_NO_REQUIRE_TAP_TRUST" "$workflow"

  untap_line="$(grep -Fn "brew untap aws/tap || true" "$workflow" | cut -d: -f1 | head -n 1)"
  install_line="$(grep -Fn "brew install xcodegen" "$workflow" | cut -d: -f1 | head -n 1)"

  [[ "$untap_line" -lt "$install_line" ]]
}
