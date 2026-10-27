#!/usr/bin/env bats
#
# Guards issue #3976: two `actions/upload-artifact` steps in different jobs of
# `pull_request.yml` uploaded under the same artifact name.
#
# upload-artifact v4 and later error on a duplicate artifact name within a
# single workflow run (v3 silently merged them). Both heap-dump steps are
# failure-gated, so the collision only bites when *both* junit-runner jobs fail
# in the same run -- exactly when you most need the dumps. The second upload
# then fails, adding an opaque failure on top of the one being diagnosed, and
# one job's heap dumps are lost.
#
# The scope here is deliberately global rather than a pin on the two known
# steps: the same class of collision is invisible until it fires, and it fires
# only on an already-failing run.
#
# Uploads nested in local composite actions (`uses: ./.github/actions/...`)
# land in the caller's artifact namespace once per invocation, so the extractor
# expands every call site rather than recording each action once (#14580), and
# reads every file with a YAML parser rather than line patterns, so key order
# and quoting cannot hide a step (#14578). See scripts/ci/workflowArtifactNames.ts
# for how per-invocation names are resolved.
#
# Two axes are out of reach of a file-static check, so do not over-trust this:
#
#   - A reusable workflow's uploads land in the *caller's* artifact namespace,
#     so a caller/callee collision spans two files. (build-control-proxy-apk,
#     build-ctrl-proxy-ios-ipa and build-video-server-jar are called this way;
#     their names do not collide with any caller's today.)
#   - A matrix job whose artifact name is a single static literal collides with
#     itself at runtime across matrix legs. Every matrix upload here correctly
#     interpolates ${{ matrix.os }}; dropping that interpolation would be the
#     same failure class as #3976 and would still pass this guard.

EXTRACTOR="$BATS_TEST_DIRNAME/../../scripts/ci/workflowArtifactNames.ts"

# Print "<workflow>\t<job>\t<artifact name>" for every upload one run of each
# given workflow performs, local composite actions expanded per invocation.
# Local actions resolve against the current directory, like GitHub's workspace.
artifact_uploads() {
  bun "$EXTRACTOR" "$@"
}

# Print "<job>\t<artifact name>" for every upload in a single workflow. The
# extractor's output is captured first so its failure is not masked by a pipe.
upload_artifact_names() {
  local uploads
  uploads="$(artifact_uploads "$1")" || return
  [ -z "$uploads" ] || printf '%s\n' "$uploads" | cut -f2-
}

# Print "<workflow>\t<artifact name>" for every name uploaded twice in one run.
duplicate_artifact_names() {
  local uploads
  uploads="$(artifact_uploads "$@")" || return
  [ -z "$uploads" ] || printf '%s\n' "$uploads" | cut -f1,3 | sort | uniq -d
}

workflows() {
  find .github/workflows -maxdepth 1 -name '*.yml' | sort
}

# A throwaway workspace with an uploading composite action written in the two
# shapes a line scanner drops: `with:` before `uses:`, and a quoted `uses:`.
make_composite_workspace() {
  workspace="$BATS_TEST_TMPDIR/workspace"
  mkdir -p "$workspace/.github/actions/upload-pair" "$workspace/.github/workflows"
  cat > "$workspace/.github/actions/upload-pair/action.yml" <<'YAML'
name: upload-pair
runs:
  using: composite
  steps:
    - name: "With before uses"
      with:
        name: composite-alpha
        path: out
      uses: actions/upload-artifact@v6
    - name: "Quoted uses"
      uses: "actions/upload-artifact@v6"
      with:
        name: composite-beta
        path: out
YAML
  cd "$workspace" || return
}

@test "the extractor finds upload-artifact steps at all" {
  # A silently-empty extractor would make every uniqueness assertion below
  # vacuously pass. Pin that it actually parses the workflow the issue is about.
  run upload_artifact_names ".github/workflows/pull_request.yml"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -gt 5 ]
}

@test "no two uploads in one workflow run share an artifact name" {
  # Composite-action uploads are counted at each call site, so this also
  # covers a workflow upload reusing a composite's name and two jobs invoking
  # the same uploading action.
  files=()
  while IFS= read -r workflow; do files+=("$workflow"); done < <(workflows)
  duplicates="$(duplicate_artifact_names "${files[@]}")"
  if [ -n "$duplicates" ]; then
    echo "Duplicate artifact names within a single workflow run:"
    echo "$duplicates"
  fi
  [ -z "$duplicates" ]
}

@test "the extractor is not fooled by key order or quoting" {
  # A guard that silently misses a duplicate is worse than no guard, so pin the
  # two shapes a sequential "uses: then name:" reader would drop: `with:` before
  # `uses:`, and a quoted `uses:` value. Both are legal YAML that nothing in the
  # repo happens to use today.
  fixture="$BATS_TEST_TMPDIR/synthetic.yml"
  cat > "$fixture" <<'YAML'
jobs:
  example:
    steps:
      - name: "With before uses"
        with:
          name: artifact-alpha
          path: out
        uses: actions/upload-artifact@v6
      - name: "Quoted uses"
        uses: "actions/upload-artifact@v6"
        with:
          name: artifact-beta
      - name: "Ordinary"
        uses: actions/upload-artifact@v6
        with:
          name: artifact-gamma
YAML

  run upload_artifact_names "$fixture"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 3 ]
  [[ "$output" == *$'example\tartifact-alpha'* ]]
  [[ "$output" == *$'example\tartifact-beta'* ]]
  [[ "$output" == *$'example\tartifact-gamma'* ]]
}

@test "junit-runner heap dumps are namespaced by job" {
  names="$(upload_artifact_names ".github/workflows/pull_request.yml")"
  [[ "$names" == *$'junit-runner-unit-tests\tjunit-runner-heap-dumps-unit'* ]]
  [[ "$names" == *$'android-emulator-tests\tjunit-runner-heap-dumps-emulator'* ]]
}

@test "junit-runner heap dump uploads stay failure-gated and tolerant" {
  # The rename must not disturb the surrounding step wiring: these dumps only
  # exist after a crash, so an unconditional upload would warn on every run.
  # Tolerant now also means continue-on-error (issue #4083): a diagnostic
  # upload flaking on a transient egress error must not red the job. The window
  # spans the four step keys above the artifact `name:` (if / continue-on-error
  # / uses / with).
  block="$(awk '
    /name: junit-runner-heap-dumps/ { print prev4 "\n" prev3 "\n" prev2 "\n" prev1 "\n" $0 }
    { prev4 = prev3; prev3 = prev2; prev2 = prev1; prev1 = $0 }
  ' ".github/workflows/pull_request.yml")"
  [ -n "$block" ]
  [ "$(echo "$block" | grep -c 'if: failure()')" -eq 2 ]
  [ "$(echo "$block" | grep -c 'continue-on-error: true')" -eq 2 ]
  [ "$(echo "$block" | grep -c 'uses: actions/upload-artifact@v[0-9]')" -eq 2 ]
}

@test "composite uploads are expanded at their real call sites" {
  # A silently-unexpanded composite would make the duplicate check above blind
  # to every upload moved into .github/actions/ (#13029). Pin one per caller.
  [[ "$(upload_artifact_names .github/workflows/pull_request.yml)" == *$'build-ide-plugin\tide-plugin-zip'* ]]
  [[ "$(upload_artifact_names .github/workflows/merge.yml)" == *$'build-ide-plugin\tide-plugin-zip'* ]]
}

@test "composite uploads are parsed structurally, not by key order or quoting" {
  # #14578: the old guard grepped eight lines after an unquoted
  # `uses: actions/upload-artifact`, so both steps below contributed nothing.
  make_composite_workspace
  cat > .github/workflows/ci.yml <<'YAML'
jobs:
  build:
    steps:
      - uses: ./.github/actions/upload-pair
YAML
  run upload_artifact_names .github/workflows/ci.yml
  [ "$status" -eq 0 ]
  [ "$output" = $'build\tcomposite-alpha\nbuild\tcomposite-beta' ]

  # So a workflow step reusing either name is a collision.
  cat >> .github/workflows/ci.yml <<'YAML'
      - uses: actions/upload-artifact@v6
        with:
          name: composite-beta
YAML
  run duplicate_artifact_names .github/workflows/ci.yml
  [ "$status" -eq 0 ]
  [ "$output" = $'.github/workflows/ci.yml\tcomposite-beta' ]
}

@test "composite uploads count once per invocation" {
  # #14580: two jobs invoking the same uploading action upload its names twice
  # in one run; the old guard recorded each action's names once globally.
  make_composite_workspace
  cat > .github/workflows/ci.yml <<'YAML'
jobs:
  first:
    steps:
      - uses: ./.github/actions/upload-pair
  second:
    steps:
      - uses: ./.github/actions/upload-pair
YAML
  run duplicate_artifact_names .github/workflows/ci.yml
  [ "$status" -eq 0 ]
  [ "$output" = $'.github/workflows/ci.yml\tcomposite-alpha\n.github/workflows/ci.yml\tcomposite-beta' ]

  # A single invocation per workflow, as in the real repo, is not a collision.
  cat > .github/workflows/other.yml <<'YAML'
jobs:
  only:
    steps:
      - uses: ./.github/actions/upload-pair
YAML
  run duplicate_artifact_names .github/workflows/other.yml
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "per-invocation names resolve the calling job and inputs" {
  # Names templated on github.job or an input differ per call site, so
  # expanding every invocation must not turn them into false collisions.
  make_composite_workspace
  mkdir -p .github/actions/templated
  cat > .github/actions/templated/action.yml <<'YAML'
inputs:
  flavor:
    default: plain
runs:
  using: composite
  steps:
    - uses: actions/upload-artifact@v6
      with:
        name: diagnostics-${{ github.job }}
    - uses: actions/upload-artifact@v6
      with:
        name: report-${{ inputs.flavor }}
YAML
  cat > .github/workflows/ci.yml <<'YAML'
jobs:
  first:
    steps:
      - uses: ./.github/actions/templated
        with:
          flavor: debug
  second:
    steps:
      - uses: ./.github/actions/templated
YAML
  run upload_artifact_names .github/workflows/ci.yml
  [ "$status" -eq 0 ]
  [ "$output" = $'first\tdiagnostics-first\nfirst\treport-debug\nsecond\tdiagnostics-second\nsecond\treport-plain' ]
  run duplicate_artifact_names .github/workflows/ci.yml
  [ -z "$output" ]
}
