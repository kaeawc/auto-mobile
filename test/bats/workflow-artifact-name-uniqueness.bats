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

# Print "<job>\t<artifact name>" for every upload-artifact step in a workflow.
#
# Capture starts only after the top-level "jobs:" key so a same-named key under
# "on:" cannot match, matching the convention in
# screenshot-diff-artifact-upload.bats. awk, not sed -- BSD sed lacks the
# range/address forms this needs.
#
# Whole step blocks are buffered and scanned at flush time rather than read as
# a "uses: then name:" sequence. YAML mapping keys are unordered, so a step
# written `with:` first and `uses:` second is legal; a sequential reader skips
# it AND then mis-attributes the *next* step's name to it, which would let a
# duplicate slip through the very guard meant to catch it. The `uses:` value is
# matched with optional quotes for the same reason.
#
# Within a block the artifact name is the `name:` under `with:` -- the step's
# own display name is `- name:`, which carries a leading dash and so cannot
# match, and it precedes `with:` in any case.
upload_artifact_names() {
  awk '
    function flush() {
      if (n_lines == 0) return
      is_upload = 0
      for (i = 1; i <= n_lines; i++) {
        if (lines[i] ~ /uses: *["'"'"']?actions\/upload-artifact/) is_upload = 1
      }
      if (is_upload) {
        in_with = 0
        for (i = 1; i <= n_lines; i++) {
          if (lines[i] ~ /^ *with: *$/) { in_with = 1; continue }
          if (in_with && lines[i] ~ /^ *name: /) {
            artifact = lines[i]
            sub(/^ *name: /, "", artifact)
            print job "\t" artifact
            break
          }
        }
      }
      n_lines = 0
    }
    /^jobs:/ { in_jobs = 1; next }
    !in_jobs { next }
    /^  [A-Za-z0-9_-]+:/ { flush(); job = $1; sub(":", "", job) }
    /^ *- / { flush() }
    { lines[++n_lines] = $0 }
    END { flush() }
  ' "$1"
}

workflows() {
  find .github/workflows -maxdepth 1 -name '*.yml' | sort
}

@test "the extractor finds upload-artifact steps at all" {
  # A silently-empty extractor would make every uniqueness assertion below
  # vacuously pass. Pin that it actually parses the workflow the issue is about.
  run upload_artifact_names ".github/workflows/pull_request.yml"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -gt 5 ]
}

@test "no two upload-artifact steps in one workflow share an artifact name" {
  duplicates=""
  while read -r workflow; do
    dupes="$(upload_artifact_names "$workflow" \
      | cut -f2 \
      | sort \
      | uniq -d)"
    if [ -n "$dupes" ]; then
      duplicates="$duplicates$workflow: $(echo "$dupes" | tr '\n' ' ')"$'\n'
    fi
  done < <(workflows)

  if [ -n "$duplicates" ]; then
    echo "Duplicate upload-artifact names within a single workflow:"
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
  [[ "$names" == *$'junit-runner-emulator-tests\tjunit-runner-heap-dumps-emulator'* ]]
}

@test "junit-runner heap dump uploads stay failure-gated and tolerant" {
  # The rename must not disturb the surrounding step wiring: these dumps only
  # exist after a crash, so an unconditional upload would warn on every run.
  block="$(awk '
    /name: junit-runner-heap-dumps/ { print prev3 "\n" prev2 "\n" prev1 "\n" $0 }
    { prev3 = prev2; prev2 = prev1; prev1 = $0 }
  ' ".github/workflows/pull_request.yml")"
  [ -n "$block" ]
  [ "$(echo "$block" | grep -c 'if: failure()')" -eq 2 ]
  [ "$(echo "$block" | grep -c 'uses: actions/upload-artifact@v[0-9]')" -eq 2 ]
}
