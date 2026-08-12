#!/usr/bin/env bats
#
# Guards release checksum handoff: Prepare Release is the single builder and
# integrity gate, while Release publishes the artifacts from that successful run.

@test "release.yml reads the checksums baked by prepare-release" {
  wiring_requires_yq
  local script
  script="$(yq -r '.jobs."verify-and-release".steps[]
    | select(.id == "prepared_checksums") | .run' ".github/workflows/release.yml" \
    | grep -v '^[[:space:]]*#')"
  [ -n "$script" ]
  [ "$script" != "null" ]
  [[ "$script" == *"RELEASE_CHECKSUM_REGISTRY"* ]]
  [[ "$script" == *"apkSha256"* ]]
  [[ "$script" == *"ipaSha256"* ]]
  [[ "$script" == *"videoJarSha256"* ]]
  [[ "$script" == *"screenCaptureHelperSha256"* ]]
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

@test "release.yml reuses prepare-release artifacts instead of rebuilding them (#4686)" {
  wiring_requires_yq
  local workflow=".github/workflows/release.yml"

  run yq -r '.on.workflow_dispatch.inputs.prepare_run_id.required' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = "true" ]

  run yq -r '.permissions.actions' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = "read" ]

  run yq -r '.on.create // "absent"' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = "absent" ]

  run yq -r '
    .jobs."verify-and-release".steps[]
    | select(.uses == "actions/download-artifact@v7")
    | .with.name + "\t" + .with."run-id" + "\t" + .with."github-token" + "\t" + .with.repository' "$workflow"
  [ "$status" -eq 0 ]

  local artifact_name
  for artifact_name in control-proxy-apk ctrl-proxy-ios-ipa video-server-jar screen-capture-helper; do
    [[ "$output" == *"${artifact_name}"$'\t''${{ inputs.prepare_run_id }}'$'\t''${{ secrets.GITHUB_TOKEN }}'$'\t''${{ github.repository }}'* ]]
  done

  run yq -r '.jobs | keys[]' "$workflow"
  [ "$status" -eq 0 ]
  [[ "$output" != *"build-ctrl-proxy-ios-ipa"* ]]
  [[ "$output" != *"build-control-proxy-apk"* ]]
  [[ "$output" != *"build-video-server-jar"* ]]
  [[ "$output" != *"build-screen-capture-helper"* ]]

  run yq -r '.jobs."verify-and-release".steps[] | select(.run != null) | .run' "$workflow"
  [ "$status" -eq 0 ]
  [[ "$output" != *"verify-artifact-sha256.sh"* ]]
  [[ "$output" != *"verify-release-integrity.sh"* ]]
}

@test "prepare-release verifies and tags the single prepared artifact set before dispatching release (#4686)" {
  wiring_requires_yq
  local workflow=".github/workflows/prepare-release.yml"
  local builder
  for builder in build-candidate-ctrl-proxy-ios-ipa build-candidate-control-proxy-apk build-candidate-video-server-jar build-candidate-screen-capture-helper; do
    run yq -r ".jobs.\"$builder\".needs" "$workflow"
    [ "$status" -eq 0 ]
    [[ "$output" == *"prepare-version"* ]]

    run yq -r ".jobs.\"$builder\".with.checkout-ref" "$workflow"
    [ "$status" -eq 0 ]
    [ "$output" = '${{ needs.prepare-version.outputs.release_commit }}' ]

    run yq -r ".jobs.\"$builder\".with.upload-artifact" "$workflow"
    [ "$status" -eq 0 ]
    [ "$output" = "true" ]

    run yq -r ".jobs.\"$builder\".with.artifact-retention-days" "$workflow"
    [ "$status" -eq 0 ]
    [ "$output" = "90" ]
  done

  run yq -r '.jobs | keys[]' "$workflow"
  [ "$status" -eq 0 ]
  [[ "$output" != *"build-ctrl-proxy-ios-ipa"* ]]
  [[ "$output" != *"build-control-proxy-apk"* ]]
  [[ "$output" != *"build-video-server-jar"* ]]
  [[ "$output" != *"build-screen-capture-helper"* ]]

  run yq -r '.jobs."verify-prepared-release".steps[] | select(.name == "Verify prepared release artifacts") | .run' "$workflow"
  [ "$status" -eq 0 ]
  [[ "$output" == *"verify-artifact-sha256.sh"* ]]
  [[ "$output" == *"verify-release-integrity.sh"* ]]

  run yq -r '.packageManager | sub("^bun@"; "")' package.json
  [ "$status" -eq 0 ]
  local expected_bun_version="$output"
  run yq -r '.jobs."verify-prepared-release".steps[] | select(.name == "Setup Bun") | .with."bun-version"' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = "$expected_bun_version" ]

  run yq -r '.jobs."verify-prepared-release".steps[] | select(.name == "Promote verified release and create tag") | .run' "$workflow"
  [ "$status" -eq 0 ]
  [[ "$output" == *'git push origin "$EXPECTED_RELEASE_COMMIT":main'* ]]
  [[ "$output" == *'git tag "$TAG" "$EXPECTED_RELEASE_COMMIT"'* ]]
}

@test "prepare-release keeps intermediate version commits on a run-scoped staging ref (#4686)" {
  wiring_requires_yq
  local workflow=".github/workflows/prepare-release.yml"

  run yq -r '.jobs."prepare-version".outputs.base_main_commit' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = '${{ steps.commit.outputs.base_main_commit }}' ]

  local prepare_commit final_commit
  prepare_commit="$(yq -r '.jobs."prepare-version".steps[] | select(.id == "commit") | .run' "$workflow")"
  final_commit="$(yq -r '.jobs."finalize-release".steps[] | select(.id == "commit") | .run' "$workflow")"
  run yq -r '.jobs."prepare-version".steps[] | select(.id == "commit") | .env.STAGING_REF' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = 'release-prepare/${{ github.run_id }}' ]
  run yq -r '.jobs."finalize-release".steps[] | select(.id == "commit") | .env.STAGING_REF' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = 'release-prepare/${{ github.run_id }}' ]
  [[ "$prepare_commit" == *'git push --force origin "HEAD:refs/heads/$STAGING_REF"'* ]]
  [[ "$prepare_commit" != *'git push origin HEAD:main'* ]]
  [[ "$final_commit" == *'git push --force origin "HEAD:refs/heads/$STAGING_REF"'* ]]
  [[ "$final_commit" != *'git push origin HEAD:main'* ]]
}

@test "prepare-release consumes the bump script's managed-path allow-list (#5008)" {
  wiring_requires_yq
  local commit_step
  commit_step="$(yq -r '.jobs."prepare-version".steps[] | select(.id == "commit") | .run' .github/workflows/prepare-release.yml)"
  # The allow-list is owned by bump-versions.sh, not restated in the workflow.
  [[ "$commit_step" == *'bump-versions.sh --print-managed-paths'* ]]
  # Capture the producer status directly; process substitution would hide a
  # partial-output failure and let the release guard continue.
  [[ "$commit_step" == *'managed_paths_output='* ]]
  [[ "$commit_step" == *'if [[ -z "$managed_paths_output" ]]; then'* ]]
  [[ "$commit_step" == *'mapfile -t allowed_patterns <<< "$managed_paths_output"'* ]]
  [[ "$commit_step" != *'mapfile -t allowed_patterns < <('* ]]
  # CHANGELOG.md is written by the changelog step, so the workflow appends it.
  [[ "$commit_step" == *'allowed_patterns+=("CHANGELOG.md")'* ]]
}

@test "bump script managed paths cover the version-synchronized CtrlProxy docs" {
  local managed
  managed="$(bash scripts/versioning/bump-versions.sh --print-managed-paths)"
  for path in \
    "docs/design-docs/mcp/daemon/client-frame-snapshot.md" \
    "docs/design-docs/mcp/daemon/client-screen-control.md" \
    "docs/design-docs/mcp/daemon/unix-socket-api.md"; do
    [[ "$managed" == *"$path"* ]]
  done
}

@test "prepared release artifacts survive delayed publication retries (#4686)" {
  wiring_requires_yq
  local workflow
  for workflow in \
    .github/workflows/build-ctrl-proxy-ios-ipa.yml \
    .github/workflows/build-control-proxy-apk.yml \
    .github/workflows/build-video-server-jar.yml \
    .github/workflows/build-screen-capture-helper.yml; do
    run yq -r '.on.workflow_call.inputs."artifact-retention-days".default' "$workflow"
    [ "$status" -eq 0 ]
    [ "$output" = "7" ]

    run yq -r '.jobs.build.steps[] | select(.uses == "actions/upload-artifact@v6") | .with."retention-days"' "$workflow"
    [ "$status" -eq 0 ]
    [ "$output" = '${{ inputs.artifact-retention-days }}' ]
  done

  run yq -r '.jobs."verify-prepared-release".steps[] | select(.name == "Upload release artifact provenance") | .with."retention-days"' .github/workflows/prepare-release.yml
  [ "$status" -eq 0 ]
  [ "$output" = "90" ]
}

@test "prepare-release verifies the prepared artifacts on the finalized tree before tagging and can rerun provenance upload (#4686)" {
  wiring_requires_yq
  local workflow=".github/workflows/prepare-release.yml"

  # verify-prepared-release gates tagging on the finalized release tree. Generic
  # CI (test/lint/build/smoke) is intentionally NOT re-run in this pipeline: it
  # already gates every PR and merge into main before a release is cut, so the
  # release pipeline runs only release-specific verification (see #4935).
  run yq -r '.jobs."verify-prepared-release".needs' "$workflow"
  [ "$status" -eq 0 ]
  [[ "$output" == *"finalize-release"* ]]

  # The release-specific gate: prepared-artifact checksums and release integrity
  # are verified against the actual built artifacts before the tag is promoted.
  run yq -r '.jobs."verify-prepared-release".steps[] | select(.name == "Verify prepared release artifacts") | .run' "$workflow"
  [ "$status" -eq 0 ]
  [[ "$output" == *"verify-artifact-sha256.sh"* ]]
  [[ "$output" == *"verify-release-integrity.sh"* ]]

  run yq -r '.jobs."verify-prepared-release".steps[] | select(.name == "Upload release artifact provenance") | .with.overwrite' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = "true" ]
}

@test "release.yml requires successful prepared-release provenance before downloading artifacts (#4686)" {
  wiring_requires_yq
  local workflow=".github/workflows/release.yml"

  run yq -r '.jobs."verify-and-release".steps[] | select(.name == "Wait for successful Prepare Release") | .run' "$workflow"
  [ "$status" -eq 0 ]
  [[ "$output" == *"conclusion"* ]]
  [[ "$output" == *"prepare-release.yml"* ]]

  run yq -r '.jobs."verify-and-release".steps[] | select(.name == "Validate prepared release provenance") | .run' "$workflow"
  [ "$status" -eq 0 ]
  [[ "$output" == *"release-artifact-provenance"* ]]
  [[ "$output" == *"tag_sha"* ]]
  [[ "$output" == *"prepare_run_id"* ]]
}

@test "release.yml builds the package before publishing npm" {
  wiring_requires_yq
  local steps build_index publish_index
  steps="$(yq -r '.jobs."verify-and-release".steps[] | (.name // "") + "\t" + (.run // "")' ".github/workflows/release.yml")"
  [[ "$steps" == *$'Build TypeScript package\tbun run build'* ]]
  [[ "$steps" == *$'Publish to npm\t'* ]]

  run yq -r '.jobs."verify-and-release".steps | to_entries[] | select(.value.name == "Build TypeScript package") | .key' ".github/workflows/release.yml"
  [ "$status" -eq 0 ]
  build_index="$output"

  run yq -r '.jobs."verify-and-release".steps | to_entries[] | select(.value.name == "Publish to npm") | .key' ".github/workflows/release.yml"
  [ "$status" -eq 0 ]
  publish_index="$output"

  (( build_index < publish_index ))

  local notes_env
  notes_env="$(yq -r '.jobs."verify-and-release".steps[] | select(.id == "release_notes") | .env' ".github/workflows/release.yml")"
  [[ "$notes_env" == *"prepared_checksums.outputs.apk"* ]]
  [[ "$notes_env" == *"prepared_checksums.outputs.ipa"* ]]
}

@test "prepare-release.yml records the video-server jar checksum (#3832)" {
  workflow=".github/workflows/prepare-release.yml"
  grep -Fq "uses: ./.github/workflows/build-video-server-jar.yml" "$workflow"
  grep -Fq "VIDEO_JAR_SHA256:" "$workflow"
}

@test "prepare-release records and verifies the screen-capture-helper before release delivery" {
  local workflow=".github/workflows/release.yml"
  ! grep -Fq "uses: ./.github/workflows/build-screen-capture-helper.yml" "$workflow"

  workflow=".github/workflows/prepare-release.yml"
  grep -Fq "uses: ./.github/workflows/build-screen-capture-helper.yml" "$workflow"
  grep -Fq "verify-release-integrity.sh" "$workflow"
  grep -Fq "SCREEN_CAPTURE_HELPER_SHA256:" "$workflow"
}

@test "screen-capture-helper release builder signs, notarizes, and uploads the universal archive" {
  local workflow=".github/workflows/build-screen-capture-helper.yml"
  grep -Fq "setup-macos-signing-keychain.sh" "$workflow"
  grep -Fq "build-screen-capture-helper-release.sh" "$workflow"
  grep -Fq "name: screen-capture-helper" "$workflow"
  grep -Fq "path: /tmp/screen-capture-helper-macos-universal.zip" "$workflow"
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

@test "release.yml runs the Maven publication manifest preflight before publishing (#4853)" {
  wiring_requires_yq
  local workflow=".github/workflows/release.yml"
  # Both steps live in the release job, and the preflight must precede the
  # publish so the manifest reflects what is about to be uploaded.
  local names preflight publish
  names="$(yq -r '.jobs."verify-and-release".steps[].name' "$workflow")"
  preflight="$(printf '%s\n' "$names" \
    | grep -nxF 'Maven Central publication manifest preflight' | cut -d: -f1)"
  publish="$(printf '%s\n' "$names" \
    | grep -nxF 'Publish Android Libraries to Maven Central' | cut -d: -f1)"
  [ -n "$preflight" ]
  [ -n "$publish" ]
  [ "$preflight" -lt "$publish" ]
}

@test "release.yml publishes the CtrlProxy release before compatible SDK distributions (#5215)" {
  wiring_requires_yq
  local workflow=".github/workflows/release.yml"

  run yq -r '.jobs."verify-and-release".steps[]
    | select(.name == "Publish Android Libraries to Maven Central")
    | ."continue-on-error" // false' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = "false" ]

  local names publish npm mcp brew release
  names="$(yq -r '.jobs."verify-and-release".steps[].name' "$workflow")"
  publish="$(printf '%s\n' "$names" \
    | grep -nxF 'Publish Android Libraries to Maven Central' | cut -d: -f1)"
  npm="$(printf '%s\n' "$names" | grep -nxF 'Publish to npm' | cut -d: -f1)"
  mcp="$(printf '%s\n' "$names" | grep -nxF 'Publish to MCP Registry' | cut -d: -f1)"
  brew="$(printf '%s\n' "$names" | grep -nxF 'Publish Homebrew formula' | cut -d: -f1)"
  release="$(printf '%s\n' "$names" | grep -nxF 'Create GitHub Release' | cut -d: -f1)"
  [ -n "$publish" ]
  [ -n "$npm" ]
  [ -n "$mcp" ]
  [ -n "$brew" ]
  [ -n "$release" ]
  [ "$release" -lt "$publish" ]
  [ "$publish" -lt "$npm" ]
  [ "$npm" -lt "$mcp" ]
  [ "$mcp" -lt "$brew" ]
  [ "$npm" -lt "$brew" ]
}

@test "release.yml preflight step calls the extracted preflight script (#4853)" {
  wiring_requires_yq
  local script
  script="$(yq -r '.jobs."verify-and-release".steps[]
    | select(.name == "Maven Central publication manifest preflight") | .run' \
    ".github/workflows/release.yml")"
  [[ "$script" == *"scripts/release/maven-publication-manifest-preflight.sh"* ]]
}

@test "the preflight script wires staging, the generator, the budget, and the summary (#4853)" {
  # The bash lives in a script (not inline YAML) so it can be linted and tested;
  # assert the script itself carries the wiring the release depends on.
  local s="scripts/release/maven-publication-manifest-preflight.sh"
  [ -x "$s" ]
  grep -q "publishAllPublicationsToCentralManifestRepository" "$s"
  grep -q "maven-publication-manifest.sh" "$s"
  grep -q "maven-usage-budget.json" "$s"
  grep -q "GITHUB_STEP_SUMMARY" "$s"
}

@test "release.yml uploads the publication manifest artifact (#4853)" {
  wiring_requires_yq
  local uses
  uses="$(yq -r '.jobs."verify-and-release".steps[]
    | select(.name == "Upload Maven publication manifest") | .uses' \
    ".github/workflows/release.yml")"
  [[ "$uses" == actions/upload-artifact@* ]]
}

# The assertions below parse the workflow as YAML rather than grepping its text.
# A raw grep is satisfied by any comment or unrelated step containing the string,
# so it would keep passing while the step it claims to pin was deleted -- and a
# wiring link that regresses silently is the exact defect this whole area exists
# to prevent. `yq` reads the real trigger and step fields instead.
#
# Release takes an explicit prepare-run ID. This is the artifact provenance
# boundary: it consumes the already checked artifacts instead of rebuilding.

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

@test "release.yml queues a validation run for hand-pushed tags without publishing (#4697)" {
  wiring_requires_yq
  local workflow=".github/workflows/release.yml"

  run yq -r '.on.push.tags[]' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = "*" ]

  run yq -r '.concurrency.group' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = 'release-${{ inputs.tag || github.ref_name }}' ]

  run yq -r '.jobs."validate-release-tag".steps[] | select(.id == "validate") | .env.TAG' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = '${{ inputs.tag || github.ref_name }}' ]

  run yq -r '.jobs."verify-and-release".if' "$workflow"
  [ "$status" -eq 0 ]
  [ "$output" = "github.event_name == 'workflow_dispatch' && needs.validate-release-tag.outputs.is_release_tag == 'true'" ]
}

@test "prepare-release dispatches release.yml on the tag with its run ID (#4686)" {
  wiring_requires_yq
  # Pull the one step's run script out of the parsed YAML, so comments elsewhere
  # in the file cannot satisfy these assertions.
  local script
  script="$(yq -r '.jobs."verify-prepared-release".steps[] | select(.name == "Start the release") | .run' \
    ".github/workflows/prepare-release.yml")"
  [ -n "$script" ]
  [ "$script" != "null" ]

  # Strip comment lines before matching, so the command has to really be there.
  local code
  code="$(printf '%s\n' "$script" | grep -v '^[[:space:]]*#')"
  [[ "$code" == *"gh workflow run release.yml"* ]]
  [[ "$code" == *'--ref "$TAG"'* ]]
  [[ "$code" != *"--ref main"* ]]
  [[ "$code" == *'prepare_run_id="$PREPARE_RUN_ID"'* ]]
  [[ "$code" == *"previous_release_run_ids"* ]]
  [[ "$code" == *'repos/$REPO/actions/workflows/release.yml/runs?event=workflow_dispatch&per_page=100'* ]]
  [[ "$code" == *'.head_branch == $tag and .head_sha == $sha'* ]]
  [[ "$code" == *'grep -Fxq "$release_run_id" <<< "$previous_release_run_ids"'* ]]
  [[ "$code" == *"Release dispatch for \$TAG did not materialize"* ]]

  run yq -r '.jobs."verify-prepared-release".steps[] | select(.name == "Start the release") | .env.PREPARE_RUN_ID' \
    ".github/workflows/prepare-release.yml"
  [ "$status" -eq 0 ]
  [ "$output" = '${{ github.run_id }}' ]
}

# The dispatch API rejects a token without actions: write, and the job-level
# block replaces the workflow-level grant wholesale. This job also creates the
# tag only after artifact verification, so it needs contents: write.
@test "prepare-release can dispatch and still push (#4157)" {
  wiring_requires_yq
  local perms
  perms="$(yq -r '.jobs."verify-prepared-release".permissions' ".github/workflows/prepare-release.yml")"
  [ "$perms" != "null" ]

  run yq -r '.jobs."verify-prepared-release".permissions.actions' ".github/workflows/prepare-release.yml"
  [ "$output" = "write" ]
  run yq -r '.jobs."verify-prepared-release".permissions.contents' ".github/workflows/prepare-release.yml"
  [ "$output" = "write" ]
}

# action-gh-release throws "GitHub Releases requires a tag" when github.ref is not
# a tag ref, and that step runs after npm/Homebrew/MCP/Maven/Docker have already
# published irreversibly. The tag must be explicit, never inferred from the ref.
@test "release.yml creates the explicitly validated tag through the GitHub Release API (#4157)" {
  wiring_requires_yq
  run yq -r '.jobs."verify-and-release".steps[]
    | select(.name == "Create GitHub Release") | .run' ".github/workflows/release.yml"
  [ "$status" -eq 0 ]
  [[ "$output" == *'gh release create "$TAG"'* ]]
  [[ "$output" == *'--verify-tag'* ]]
  [[ "$output" == *'gh release upload "$TAG"'* ]]
  [[ "$output" == *'--clobber'* ]]
  [[ "$output" == *'--json isDraft,assets'* ]]
  [[ "$output" == *'--draft=false'* ]]
  [[ "$output" == *'Refusing to overwrite assets on a published release.'* ]]
  [[ "$output" == *'AutoMobile-${VERSION}-macos.dmg'* ]]
  [[ "$output" != *'AutoMobile-*-macos.dmg'* ]]
}

@test "desktop installer verification requires the stable versioned asset names" {
  local script="scripts/ci/verify-desktop-installer-assets.sh"
  [ -x "$script" ]

  local fixture
  fixture="$(mktemp -d)"
  printf 'installer\n' > "$fixture/AutoMobile-1.2.3-macos.dmg"
  printf 'installer\n' > "$fixture/AutoMobile-1.2.3-windows.msi"
  printf 'installer\n' > "$fixture/AutoMobile-1.2.3-linux.deb"

  run bash "$script" "1.2.3" "$fixture"
  [ "$status" -eq 0 ]

  rm "$fixture/AutoMobile-1.2.3-linux.deb"
  run bash "$script" "1.2.3" "$fixture"
  [ "$status" -ne 0 ]
  [[ "$output" == *"AutoMobile-1.2.3-linux.deb"* ]]
  rm -rf "$fixture"
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
