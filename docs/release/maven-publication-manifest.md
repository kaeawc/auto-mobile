# Maven Central publication manifest & usage-budget preflight

Tracking issue: #4853.

Every tagged AutoMobile release uploads four Maven coordinates to Maven Central.
Until now nothing made the exact set of uploaded files — or its size and count —
visible before the upload happened. Maven Central's Usage Center meters
organization-level file count and release size, so a release that quietly grows
the artifact set is worth catching _before_ it ships. This preflight produces a
deterministic manifest of exactly what a release would upload, checks it against
an advisory budget, and records it in the release run — with no Maven Central
credentials and no remote publish.

## How it works

1. **Stage locally.** `android/build.gradle.kts` registers a `centralManifest`
   Maven repository that points at `android/build/central-manifest/`, gated behind
   `-PmavenManifestStaging` so it stays off the production `publish` lifecycle.
   Publishing to it (`publishAllPublicationsToCentralManifestRepository`) writes
   the same files a release uploads — primary artifact, POM, Gradle module
   metadata, sources and Javadoc jars, PGP signatures, and checksums — into one
   local directory. It uploads nowhere and does not touch the real Central path.
2. **Enumerate.** `scripts/release/maven-publication-manifest.sh` walks that tree
   and prints a deterministic, path-independent manifest: one line per file
   (`coordinate classifier filename bytes`), per-coordinate subtotals, classifier
   totals, and a release grand total.
3. **Budget.** With `--budget scripts/release/maven-usage-budget.json` it compares
   the release totals against advisory thresholds. A breach prints `BUDGET WARN`
   and, by default, **still exits 0** — the preflight reports, it never blocks, so
   an urgent security release always ships. Only `--strict` turns a breach (or an
   unexpected file) into a non-zero exit.
4. **Record.** `scripts/release/maven-publication-manifest-preflight.sh`
   orchestrates the release-CI flow — stage all four modules, run the generator
   with the budget, write the full manifest, append the totals to the job
   summary. It lives in a script (not inline in the workflow) so it is linted and
   BATS-tested on its own; set `STAGING_DIR` to skip the Gradle staging and run it
   against an already-staged tree. In `release.yml` it runs immediately before the
   publish step and uploads the full manifest as the `maven-publication-manifest`
   artifact.

## File taxonomy

Each staged file is classified so downstream work can target a specific class:

| Classifier                    | Meaning                                                                     |
| ----------------------------- | --------------------------------------------------------------------------- |
| `main-jar` / `main-aar`       | Primary artifact (JVM modules ship a jar; the Android library ships an aar) |
| `sources-jar` / `javadoc-jar` | Sources and Javadoc archives                                                |
| `pom` / `module`              | Maven POM and Gradle Module Metadata                                        |
| `maven-metadata`              | `maven-metadata.xml`                                                        |
| `signature`                   | `.asc` PGP signature of a primary file                                      |
| `checksum`                    | `.md5/.sha1/.sha256/.sha512` of a primary file or metadata                  |
| `signature-checksum`          | Checksum of a `.asc` signature (the redundant set #4851 targets)            |
| `unexpected`                  | Anything else — a novel classifier or a stray sidecar                       |

`unexpected` is how the preflight detects accidental new classifiers or sidecars:
under `--strict` any unexpected file fails the run.

## Regression oracle for artifact reduction

The manifest was the before/after oracle for the artifact-reduction work:

- **#4851** (eliminate signature checksums) needed **no change**. The manifest
  measures the local Gradle staging repo, which does write `.asc.md5`/`.asc.sha1`
  sidecars — but vanniktech's Central Portal upload _bundle_
  (`android/build/publish/*.zip`) already omits them (it ships only `.md5`+`.sha1`
  for primaries, no signature checksums, no `sha256`/`sha512`, no metadata). So
  the checksums-of-signatures are never uploaded; the issue was closed as
  already-resolved.
- **#4852** (reduce the Dokka Javadoc payload) shipped an **empty Javadoc jar**.
  `auto-mobile-sdk` published the full Dokka HTML site — 1,779,714 bytes, ~38% of
  the staged release, of which ~1.2 MB was client-side search/navigation
  JavaScript, a search index, and web fonts. Maven Central requires a
  `-javadoc.jar` to exist but not to contain HTML, so `auto-mobile-sdk`'s
  `mavenPublishing` now uses `JavadocJar.Empty()`: the jar drops to **261 bytes**
  (an empty `META-INF/MANIFEST.MF`), matching the other three modules. The release
  aar and the real sources jar are unchanged, and Dokka stays applied for local or
  hosted doc generation. The `maxJavadocJarBytes` guard in
  `maven-usage-budget.json` (advisory) keeps it from regressing to the HTML site.

Capture the manifest, make the change, re-capture, and diff.

## Current baseline

Measured from a local staging of all four coordinates at version `0.0.47`
(Gradle 9.6.1 emits four checksums per file):

| Coordinate                         | Files (unsigned) | Bytes    |
| ---------------------------------- | ---------------- | -------- |
| `auto-mobile-sdk`                  | 30               | ~2.19 MB |
| `auto-mobile-protocol`             | 30               | ~1.07 MB |
| `auto-mobile-junit-runner`         | 30               | ~0.47 MB |
| `auto-mobile-test-plan-validation` | 30               | ~0.19 MB |

Signing (enabled in release CI) adds a `.asc` plus its four checksums for each
signed primary in the local staging, which is what brings the local count to
roughly 200 files — though the actual Central upload bundle is far smaller (see
the #4851 note above). After #4852, every module's Javadoc jar is an empty ~261
bytes.

## Budget

`maven-usage-budget.json` records both the real Central ceilings and the
per-release guardrails:

- `centralOrgLimits` — the Maven Central Usage Center ceilings, which are
  **monthly** and **aggregate across the whole org**: 80 MB release size, 1000
  files, 7 releases. Observed 2026-07: 15.43 MB, 320 files, 4 releases.
- `perRelease` — what the preflight actually checks: one tagged release's staged
  footprint. Because the local file repo over-counts versus Central (see below), a
  release Central tallies at ~80 files shows here as ~200 signed, so these are
  relative guardrails with headroom, sized to keep a normal release cadence well
  inside the monthly ceilings.

## Caveats

- The local file repository also writes `maven-metadata.xml` per coordinate and
  every Gradle checksum. The Central Portal bundle regenerates metadata
  server-side and counts differently, so the manifest **over-counts** versus the
  final Central state (the Usage Center showed ~80 files/release against ~200 here
  signed). This is intentional: the manifest reflects what Gradle produces, and
  the relative before/after signal — the point of the oracle — is unaffected.
- The budget is advisory. Raise a ceiling deliberately whenever a new coordinate
  is added, and keep `maxJavadocJarBytes` small so the empty Javadoc jar cannot
  regress to the Dokka HTML site.
