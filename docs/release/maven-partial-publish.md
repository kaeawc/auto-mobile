# Publishing only the affected Maven modules (design)

Tracking issue: [#4850](https://github.com/kaeawc/auto-mobile/issues/4850). **This
is a design document only — no publish behavior changes until it is reviewed.**

Every tagged release currently runs `publish` for all four Maven coordinates,
even when a module did not change. This proposes a path-based selection that
publishes only the modules a release actually affects, while **retaining the
single shared release-version train** (this design does *not* decouple Maven
versions from the release version) and never leaving a published POM pointing at
a coordinate that does not exist.

## The four published coordinates and their edges

| Module | Coordinate | Project dependency |
|---|---|---|
| `protocol` | `auto-mobile-protocol` | — (leaf) |
| `test-plan-validation` | `auto-mobile-test-plan-validation` | — (leaf) |
| `junit-runner` | `auto-mobile-junit-runner` | `api(project(":test-plan-validation"))` |
| `auto-mobile-sdk` | `auto-mobile-sdk` | `implementation(project(":protocol"))` |

`control-proxy` is bundled into `junit-runner`, not published. Group is
`dev.jasonpearson.auto-mobile`. Both `api` and `implementation` project
dependencies appear in the published POM (as `compile` and `runtime` scope
respectively), each pinned to the **shared release version `V`**.

## The correctness constraint

Because the version train is shared, a module built at version `V` produces a POM
that references its project dependencies **at `V`**. Therefore:

> **If a coordinate is published at `V`, every coordinate its POM names must also
> exist at `V`.**

That yields one rule for the selection set:

> **Publish set = the source-changed modules plus their transitive dependencies
> (the downward closure toward the leaves). Never the consumers.**

Publishing a consumer forces its dependencies (so `auto-mobile-sdk` drags in
`protocol`); publishing a dependency does **not** force its consumers. A
`protocol`-only change leaves `auto-mobile-sdk` simply *absent* at `V` — its
previous release still resolves `protocol` at its own older version, which remains
on Central — so nothing dangles. What is *not* produced is a same-version
`auto-mobile-sdk:V`; consumers who pin the exact release version to an unchanged
module get the last version at which it was published, which is the intended
behavior of a partial release.

## Publish-selection matrix

| Source changed | Published set (closure) | Rationale |
|---|---|---|
| `protocol` | `protocol` | leaf; no deps |
| `test-plan-validation` | `test-plan-validation` | leaf |
| `junit-runner` | `junit-runner`, `test-plan-validation` | POM pins t-p-v at `V` |
| `auto-mobile-sdk` | `auto-mobile-sdk`, `protocol` | POM pins protocol at `V` |
| `protocol` + `junit-runner` | `protocol`, `junit-runner`, `test-plan-validation` | union of closures |
| **shared config** — root `build.gradle.kts`, `settings.gradle.kts`, `gradle/libs.versions.toml`, signing/publishing config (a bare version bump in `gradle.properties`/`package.json` is *excluded*, see below) | **all four** | a real shared change can affect every module's bytecode or POM |
| detection fails / ambiguous | **all four** (safe fallback) | never under-publish |

## Change detection

Path-based, comparing the tag being released against the **previous release tag**
(`git diff <prev-release-tag>..<this-tag>`), with a conservative bias toward
publishing more. The base is the previous release tag, not a `merge-base`: the two
release tags sit on the same line of history, so the direct tag-to-tag diff is
what defines "what changed since the last release," and `merge-base` needs a
second ref it does not have here.

**Exclude the mechanical version bump first.** `prepare-release.yml` rewrites the
release version on every release — `VERSION_NAME` in `android/gradle.properties`
and `version` in the root `package.json`. If those counted as changes, *every*
release would trip the shared-config rule and publish all four, making the entire
optimization inert. Detection therefore ignores a change confined to those version
fields; only a *non-version* edit to those files is a real change.

Then:

- Each module maps to its own source tree plus its own `build.gradle.kts` and
  module `gradle.properties`: e.g. `auto-mobile-sdk` → `android/auto-mobile-sdk/**`.
- `junit-runner` additionally reads the root `package.json` version into its
  published JAR's `Implementation-Version`. That field *is* the version bump
  (excluded above), so a version-only `package.json` change does not select
  `junit-runner` — its embedded version intentionally lags to the last version at
  which it was actually published. A *non-version* `package.json` change the build
  consumes would select it.
- A change under any **shared** path (`android/build.gradle.kts`,
  `android/settings.gradle.kts`, `android/gradle/libs.versions.toml`, the
  signing/publishing config) — anything that can alter every module's bytecode or
  POM — selects **all four**.
- Any selected module then expands to its dependency closure via the static edge
  table above (kept in one place so it cannot drift from the build).
- If the previous-release tag or the diff cannot be resolved, or the detector
  errors, it **fails open to all four** — under-publishing is the only unsafe
  outcome.

## Dry-run mode

The selection step runs first and **prints the chosen coordinates and the reason
for each** (changed vs. pulled-in-by-closure vs. shared-config-all) to the job
summary, before any upload. A `--dry-run` invocation stops there, so the matrix
can be reviewed on a real tag without publishing. The publication manifest
preflight (issue #4853) then reports what each selected coordinate would upload —
once it takes the selection as input (see below).

## Interactions that must change

- **`scripts/release/already-published.sh`** probes all four coordinates today and
  fails closed on a *partial* set. Under partial publishing it must take the
  **selected** set as input and **return which of the selected coordinates are
  still missing**, not an aggregate yes/no — a publish that failed midway (a
  selected leaf published, its selected consumer not) is resumed by republishing
  exactly the missing ones, and an aggregate answer cannot express that.
- **The publication manifest preflight** (`maven-publication-manifest-preflight.sh`,
  issue #4853) currently stages a hardcoded all-four module list. To report exactly
  the selected coordinates it must accept the selection as input and stage only
  those. The selection is therefore computed once, before the preflight, and
  threaded into the preflight, the guard, and the publish step.
- **The publish step** in `release.yml` currently invokes leaves then consumers
  unconditionally; it becomes "publish the selected set, still leaves-before-
  consumers within that set."
- **The release summary** lists all four Maven coordinates; it should list only the
  ones actually published, and note the ones skipped (unchanged).

## Safe fallback

The all-four path stays the default and the explicit fallback: selecting all four
is always correct (it is today's behavior). Partial selection is a **reduction of
an always-safe superset**, never an expansion of a risky subset. A
`FORCE_PUBLISH_ALL` switch (workflow input) forces it regardless of detection, for
a first cut of a coordinate, a re-cut, or any doubt.

## Proposed tests (for the implementation PR, not this one)

- Unit tests over the selection function: each single-module change → its closure;
  shared-config change → all four; multi-module change → union; empty/ambiguous →
  all four.
- A rerun test: re-running a partial publish where some selected coordinates are
  already published skips them (via the adjusted `already-published.sh`) and does
  not fail on a duplicate GAV.
- A dry-run test asserting the printed coordinate set matches the matrix for
  representative diffs, with no upload attempted.

## Open questions

- **Metadata / discoverability:** `maven-metadata.xml` is regenerated by Central;
  a partial release does not update the unchanged coordinates' metadata, which is
  correct (they did not change). Worth confirming against the Central Portal
  behavior before enabling.
- **Threshold for "shared":** the list of shared paths is deliberately broad;
  refine it only with evidence that a given shared file cannot affect a module's
  published output.
