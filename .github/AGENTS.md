# .github — agent guidance

CI runs a **Fast Validation** job (`.github/workflows/pull_request.yml` →
`scripts/all_fast_validate_checks.sh`) that gates merges. When you modify any of
the files it checks, run the matching validation locally _before_ pushing so the
PR check does not fail:

| If you change…                             | Run locally                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| Test plan YAML (`**/test-plans/**/*.yaml`) | `bun run validate:yaml`                                                   |
| Any CI workflow or files under `.github/`  | `scripts/all_fast_validate_checks.sh`                                     |
| XML resources                              | `scripts/all_fast_validate_checks.sh --only xml`                          |
| Shell scripts under `scripts/`             | `scripts/all_fast_validate_checks.sh --only shellcheck` (or `shellcheck`) |
| MkDocs nav / docs structure                | `scripts/all_fast_validate_checks.sh --only mkdocs-nav`                   |
| Kotlin sources                             | `scripts/all_fast_validate_checks.sh --only ktfmt`                        |

Run the whole suite at once with `scripts/all_fast_validate_checks.sh` (it mirrors
the CI job's `--only yaml,xml,shellcheck,mkdocs-nav,ktfmt,claude-plugin,codex-skills`).

Do not add a new standalone validation workflow for something the fast-validation
aggregator already covers — extend `all_fast_validate_checks.sh` and let the
existing Fast Validation job pick it up.
