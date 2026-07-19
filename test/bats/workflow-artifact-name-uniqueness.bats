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

# Print "<job>\t<artifact name>" for every upload-artifact step in a workflow.
#
# Capture starts only after the top-level "jobs:" key so a same-named key under
# "on:" cannot match, matching the convention in
# screenshot-diff-artifact-upload.bats. awk, not sed -- BSD sed lacks the
# range/address forms this needs.
#
# `name:` is read as the first name key following the `uses:` line, which is
# the `with.name` input; the *step's* own display name precedes `uses:` and so
# is never picked up.
upload_artifact_names() {
  awk '
    /^jobs:/ { in_jobs = 1; next }
    !in_jobs { next }
    /^  [A-Za-z0-9_-]+:/ { job = $1; sub(":", "", job) }
    /uses: actions\/upload-artifact/ { pending = 1; next }
    pending && /^ *name: / {
      artifact = $0
      sub(/^ *name: /, "", artifact)
      print job "\t" artifact
      pending = 0
    }
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
