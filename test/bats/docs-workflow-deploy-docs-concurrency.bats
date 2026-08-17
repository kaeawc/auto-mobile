#!/usr/bin/env bats
#
# Guards issue #3578: overlapping documentation deploys (a manual dispatch
# racing the nightly schedule) each reach actions/deploy-pages@v4, and GitHub
# Pages allows only one in-progress deployment per environment — the loser
# errors out. The deploy-docs job must serialize via a job-scoped `concurrency`
# block (group "pages", cancel-in-progress: false) so deploys queue instead
# of racing, without serializing the rest of the workflow.

WORKFLOW=".github/workflows/docs.yml"

# Extract the deploy-docs job block: from its "  deploy-docs:" line up to
# (but not including) the next top-level (2-space-indented) job key.
deploy_docs_block() {
  awk '
    /^  deploy-docs:/ { capture=1 }
    capture && /^  [A-Za-z0-9_-]+:/ && !/^  deploy-docs:/ { exit }
    capture { print }
  ' "$WORKFLOW"
}

@test "deploy-docs job has a job-scoped concurrency block" {
  block="$(deploy_docs_block)"
  [ -n "$block" ]
  echo "$block" | grep -Eq '^    concurrency:'
}

@test "deploy-docs concurrency group is scoped to pages deploys" {
  block="$(deploy_docs_block)"
  echo "$block" | grep -Fq 'group: "pages"'
}

@test "deploy-docs concurrency does not cancel in-progress deploys" {
  block="$(deploy_docs_block)"
  echo "$block" | grep -Fq 'cancel-in-progress: false'
}

@test "workflow grants Actions read permission for cross-workflow artifacts" {
  grep -Eq '^  actions: read$' "$WORKFLOW"
}

@test "deploy-docs only publishes the main branch" {
  block="$(deploy_docs_block)"
  echo "$block" | grep -Fq "github.ref == 'refs/heads/main'"
}

@test "top-level workflow concurrency is untouched (only deploy-docs job is scoped)" {
  # The fix must not add a workflow-level concurrency block, which would
  # serialize the entire On Merge workflow instead of just Pages deploys.
  top_level_concurrency_count="$(awk '/^concurrency:/' "$WORKFLOW" | wc -l | tr -d ' ')"
  [ "$top_level_concurrency_count" -eq 0 ]
}
