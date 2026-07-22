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

@test "release.yml runs the Bun image smoke without the retired Wasm OSR override (#4009)" {
  smoke_block="$(sed -n '/name: Run Bun image runtime smoke/,/run: bun run test:image:bun/p' ".github/workflows/release.yml")"

  [[ "$smoke_block" == *"run: bun run test:image:bun"* ]]
  [[ "$smoke_block" != *"BUN_JSC_useWasmOSR"* ]]
  [[ "$smoke_block" != *"@jimp/wasm-webp"* ]]
}

@test "prepare-release.yml runs the release-integrity gate" {
  grep -q "verify-release-integrity.sh" ".github/workflows/prepare-release.yml"
}

@test "workflows install XcodeGen through the pinned installer, never bare brew" {
  # Supersedes the old aws-tap-untap assertion. That untap existed only to
  # silence Homebrew's untrusted-tap warning during `brew install xcodegen`;
  # the installer no longer uses Homebrew at all, so the warning — and the
  # need to untap — is gone.
  #
  # A bare `brew install xcodegen` resolves against whatever formula index the
  # runner ships (2.45.4 on macos-26 vs 2.46.0 for contributors). Those order
  # the PBXProject `targets` array differently, so an unpinned generator makes
  # every PR fail the drift check with an ordering-only diff (issue #3975).
  # Scan every workflow rather than a hard-coded list, so a newly added one
  # cannot reintroduce a bare install unnoticed.
  run bash -c "grep -rIl -F 'xcodegen' .github/workflows/ || true"
  [ -n "$output" ]
  for workflow in $output; do
    ! grep -Fq "brew install xcodegen" "$workflow"
  done
  grep -rIq -F "scripts/ios/install-xcodegen.sh" .github/workflows/

  # Retained from #3551, independent of xcodegen: tap trust must not be
  # disabled wholesale to silence Homebrew warnings.
  ! grep -rIq -F "HOMEBREW_NO_REQUIRE_TAP_TRUST" .github/workflows/
}

@test "no script installs XcodeGen via bare brew" {
  # The contributor-facing half of #3975: these regenerate project files, so an
  # unpinned install here commits a skewed pbxproj even with CI pinned.
  # grep -rIn emits "file:line:content", so strip that prefix before deciding
  # whether the hit is a comment — several of these scripts discuss the old
  # bare-brew install in their header comments.
  run bash -c "grep -rIn --include='*.sh' -F 'brew install xcodegen' scripts/ \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true"
  [ -z "$output" ]
}

# The assertions below parse the workflow as YAML rather than grepping its text.
# A raw grep is satisfied by any comment or unrelated step containing the string,
# so it would keep passing while the step it claims to pin was deleted -- and a
# wiring link that regresses silently is the exact defect this whole area exists
# to prevent. `yq` reads the real trigger and step fields instead.
#
# Pushing the tag does not start Release on its own: the `create` event never
# fired for the tags CI pushed at 0.0.42 and 0.0.44, so ~26 versions were
# published by hand while CI reported green.

# Skipping locally is a convenience; skipping in CI would silently retire every
# assertion below, which is the same fail-green these guards exist to catch.
wiring_requires_yq() {
  command -v yq >/dev/null 2>&1 && return 0
  if [[ -n "${CI:-}" ]]; then
    echo "yq is required in CI to verify release workflow wiring" >&2
    return 1
  fi
  skip "yq not installed"
}

@test "release.yml accepts a workflow_dispatch carrying a tag input (#4157)" {
  wiring_requires_yq
  run yq -r '.on.workflow_dispatch.inputs.tag.required' ".github/workflows/release.yml"
  [ "$status" -eq 0 ]
  [ "$output" = "true" ]
}

@test "prepare-release dispatches release.yml on the tag, not a branch (#4157)" {
  wiring_requires_yq
  # Pull the one step's run script out of the parsed YAML, so comments elsewhere
  # in the file cannot satisfy these assertions.
  local script
  script="$(yq -r '.jobs.prepare.steps[] | select(.name == "Start the release") | .run' \
    ".github/workflows/prepare-release.yml")"
  [ -n "$script" ]
  [ "$script" != "null" ]

  # Strip comment lines before matching, so the command has to really be there.
  local code
  code="$(printf '%s\n' "$script" | grep -v '^[[:space:]]*#')"
  [[ "$code" == *"gh workflow run release.yml"* ]]
  [[ "$code" == *'--ref "$TAG"'* ]]
  [[ "$code" != *"--ref main"* ]]
}

# action-gh-release throws "GitHub Releases requires a tag" when github.ref is not
# a tag ref, and that step runs after npm/Homebrew/MCP/Maven/Docker have already
# published irreversibly. The tag must be explicit, never inferred from the ref.
@test "release.yml passes an explicit tag_name to action-gh-release (#4157)" {
  wiring_requires_yq
  run yq -r '.jobs."verify-and-release".steps[]
    | select(.uses != null and (.uses | test("^softprops/action-gh-release")))
    | .with.tag_name' ".github/workflows/release.yml"
  [ "$status" -eq 0 ]
  [ "$output" = '${{ needs.validate-release-tag.outputs.tag }}' ]
}

# release.yml publishes to six targets in one job and npm publish is not
# idempotent, so every target that rejects a duplicate must be guarded or a
# failure late in the job makes the release unrerunnable. Homebrew and the
# GitHub Release are intentionally unguarded: update-brew-formula.sh already
# no-ops on an unchanged formula, and action-gh-release updates in place.
@test "release.yml guards every non-idempotent publish (#4157)" {
  wiring_requires_yq
  local target
  for target in npm mcp maven; do
    local script
    script="$(yq -r ".jobs.\"verify-and-release\".steps[] | select(.run != null) | .run" \
      ".github/workflows/release.yml" \
      | grep -v '^[[:space:]]*#' \
      | grep -F "already-published.sh $target \"\$VERSION\"")"
    [ -n "$script" ]
  done
}

# The guard fails closed, but that only reaches the job if its exit status can
# propagate. Under set -e a failing command substitution inside an `if` condition
# does NOT abort, so the inline form would silently downgrade an
# unreachable-registry error into "not published" and publish anyway.
@test "release.yml assigns the guard result before testing it (#4157)" {
  wiring_requires_yq
  local runs
  runs="$(yq -r '.jobs."verify-and-release".steps[] | select(.run != null) | .run' \
    ".github/workflows/release.yml" | grep -v '^[[:space:]]*#')"
  [[ "$runs" == *'state=$(scripts/release/already-published.sh'* ]]
  [[ "$runs" != *'if [ "$(scripts/release/already-published.sh'* ]]
}

# A dispatch that merely names the tag is not enough: the Actions UI ref picker
# defaults to a branch, and docker/metadata-action reads github.ref, so a run
# dispatched from main ships an image with no version tag while reporting green.
@test "release.yml requires the dispatch to run on the named tag (#4157)" {
  wiring_requires_yq
  local script
  script="$(yq -r '.jobs."validate-release-tag".steps[]
    | select(.id == "validate") | .run' ".github/workflows/release.yml" \
    | grep -v '^[[:space:]]*#')"
  [[ "$script" == *'REF_TYPE'* ]]
  [[ "$script" == *'REF_NAME'* ]]
}
