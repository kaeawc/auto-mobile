#!/usr/bin/env bats
#
# Guards issue #4083: a transient GitHub egress flap on a *diagnostic* artifact
# upload (ENOTFOUND while running actions/upload-artifact) must not turn an
# otherwise-green job red. The build and tests have already run by the time logs
# or heap dumps are uploaded; their upload is best-effort diagnostics.
#
# Observed failure (Node TypeScript Build and Test, windows-latest):
#   Upload Build/Test Logs | ##[error]Failed to CreateArtifact: ... ENOTFOUND
#
# Every step in pull_request.yml whose name marks it as a diagnostic upload
# (Logs / Heap Snapshots / Heap Dumps) must carry `continue-on-error: true`.
# Functional-deliverable uploads (APK, coverage badges, plugin ZIP, test-result
# bundles that feed a report gate) are intentionally excluded -- their upload
# failing is meaningful.

WORKFLOW=".github/workflows/pull_request.yml"

# Print, one per line, "<name>|<has_continue_on_error>" for every step whose
# name matches a diagnostic-upload pattern. A step block runs from its
# "      - name:" line to the next step start ("      - ") or a step-indent
# comment ("      #"). awk, not sed -- BSD sed lacks the range forms this needs.
diagnostic_upload_steps() {
  awk '
    function flush() {
      if (name != "" && block ~ /upload-artifact/ &&
          name ~ /Upload .*(Logs|Heap Snapshots|Heap Dumps)/) {
        printf "%s|%s\n", name, (block ~ /continue-on-error: true/ ? "yes" : "no")
      }
      name = ""; block = ""
    }
    /^      [-#]/ { flush() }
    /^      - name:/ {
      line = $0
      sub(/^[^"]*"/, "", line); sub(/".*$/, "", line)
      name = line
    }
    { block = block $0 "\n" }
    END { flush() }
  ' "$WORKFLOW"
}

@test "diagnostic upload steps are present in pull_request.yml" {
  run diagnostic_upload_steps
  [ "$status" -eq 0 ]
  # Sanity floor: we expect at least the known diagnostic upload sites.
  [ "$(echo "$output" | grep -c .)" -ge 8 ]
}

@test "every diagnostic log/heap upload is continue-on-error: true" {
  local offenders
  offenders="$(diagnostic_upload_steps | grep '|no$' || true)"
  if [ -n "$offenders" ]; then
    echo "Diagnostic upload steps missing 'continue-on-error: true':" >&2
    echo "$offenders" >&2
  fi
  [ -z "$offenders" ]
}
