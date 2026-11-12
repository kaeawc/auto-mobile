# CircleCI macOS jobs

CircleCI carries the PR Playground job and all post-merge and nightly macOS work; the
[macOS CI capacity plan](macos-capacity-plan.md) says which job runs where. This page covers how
CircleCI reports to GitHub, why release and signing stay on GitHub, and the project settings.

## How CircleCI reports

CircleCI posts **commit statuses**, not check runs, with the context `ci/circleci: <job name>`, where
`<job name>` is the workflow invocation's `name:` (or the job key). They are created by
`circleci-app[bot]`, the CircleCI GitHub App (app id **302869**, slug `circleci-app`).

The required contexts in the `green-main` ruleset are bare names pinned to integration **15368**
(GitHub Actions), so a CircleCI status can never satisfy them. CircleCI also posts nothing when path
filtering skips the workflow, and a ruleset cannot mark a missing status as skipped. No CircleCI job
may therefore mirror a required GitHub check name; a gate that waits on a CircleCI status must be a
GitHub Actions job that counts only statuses created by `circleci-app[bot]`.

## Release and signing stay on GitHub

Release and signing workflows (`build-ctrl-proxy-ios-ipa`, `build-network-filter-probe`,
`build-prototype-agent`, `build-screen-capture-helper`, the desktop installers) run on GitHub. If they
ever move, use one context, for example `automobile-apple-signing`, with all three restriction types: a
security group (a team containing only the owner), a project restriction (this project only), and an
expression restriction such as `pipeline.git.branch == "main" or pipeline.git.tag starts-with "v"`.
Attach it only in workflows whose jobs carry `filters: { branches: { only: main } }` / tag filters.
CircleCI fails the workflow as `Unauthorized` when a restriction does not match
([Contexts](https://circleci.com/docs/guides/security/contexts/)).

## Project settings (CircleCI web app)

- **Project Settings → Advanced:**
  - "Enable dynamic config using setup workflows": **On** (required by `.circleci/config.yml`).
  - "Build forked pull requests": **On**.
  - "Pass secrets to builds from forked pull requests": **Off**, the default
    ([open source docs](https://circleci.com/docs/guides/integration/oss/)).
  - "Only build pull requests": **On**, so branch pushes without a PR do not spend macOS credits.
- **Project Settings → Environment Variables:** empty; the executor pins signing off.
- **Organization Settings → Contexts:** none, unless release jobs move (above).

## Validation

`test/scripts/circleciMacosMigrationPolicy.test.ts` checks, among others, that pull requests schedule
only the advisory Playground simulator job, that no CircleCI job mirrors a required GitHub check name,
that `nightly.yml` and `merge.yml` schedule no GitHub-hosted macOS job, and that no CircleCI workflow
attaches a context and the macOS executor pins signing off.

## Background

- [Moving GitHub-hosted macOS jobs to CircleCI](../../devlog/2026-10-09-circleci-macos-migration-plan.md):
  the sourced CircleCI plan numbers, load measurements and the superseded migration plan.
