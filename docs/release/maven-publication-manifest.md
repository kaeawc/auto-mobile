# Maven Central publication manifest & usage-budget preflight

Tracking issue: #4853.

Every tagged AutoMobile release uploads four Maven coordinates to Maven Central.
Until now nothing made the exact set of uploaded files — or its size and count —
visible before the upload happened. Maven Central's Usage Center meters
organization-level file count and release size, so a release that quietly grows
the artifact set is worth catching *before* it ships. This preflight produces a
deterministic manifest of exactly what a release would upload, checks it against
an advisory budget, and records it in the release run — with no Maven Central
credentials and no remote publish.

## How it works

1. **Stage locally.** `android/build.gradle.kts` registers a `centralManifest`
   Maven repository that points at `android/build/central-manifest/`. Publishing
   to it (`publishAllPublicationsToCentralManifestRepository`) writes the same
   files a release uploads — primary artifact, POM, Gradle module metadata,
   sources and Javadoc jars, PGP signatures, and checksums — into one local
   directory. It uploads nowhere and does not touch the real Central path.
2. **Enumerate.** `scripts/release/maven-publication-manifest.sh` walks that tree
   and prints a deterministic, path-independent manifest: one line per file
   (`coordinate classifier filename bytes`), per-coordinate subtotals, classifier
   totals, and a release grand total.
3. **Budget.** With `--budget scripts/release/maven-usage-budget.json` it compares
   the release totals against advisory thresholds. A breach prints `BUDGET WARN`
   and, by default, **still exits 0** — the preflight reports, it never blocks, so
   an urgent security release always ships. Only `--strict` turns a breach (or an
   unexpected file) into a non-zero exit.
4. **Record.** In `release.yml` the preflight runs immediately before the publish
   step, appends the totals to the job summary, and uploads the full manifest as
   the `maven-publication-manifest` artifact.

## File taxonomy

Each staged file is classified so downstream work can target a specific class:

| Classifier | Meaning |
|---|---|
| `main-jar` / `main-aar` | Primary artifact (JVM modules ship a jar; the Android library ships an aar) |
| `sources-jar` / `javadoc-jar` | Sources and Javadoc archives |
| `pom` / `module` | Maven POM and Gradle Module Metadata |
| `maven-metadata` | `maven-metadata.xml` |
| `signature` | `.asc` PGP signature of a primary file |
| `checksum` | `.md5/.sha1/.sha256/.sha512` of a primary file or metadata |
| `signature-checksum` | Checksum of a `.asc` signature (the redundant set #4851 targets) |
| `unexpected` | Anything else — a novel classifier or a stray sidecar |

`unexpected` is how the preflight detects accidental new classifiers or sidecars:
under `--strict` any unexpected file fails the run.

## Regression oracle for artifact reduction

The manifest is the before/after oracle for the artifact-reduction work:

- **#4851** (eliminate signature checksums) shrinks the `signature-checksum`
  count to zero.
- **#4852** (reduce the Dokka Javadoc payload) shrinks the `javadoc-jar` bytes.

Capture the manifest, make the change, re-capture, and diff.

## Current baseline

Measured from a local staging of all four coordinates at version `0.0.47`
(Gradle 9.6.1 emits four checksums per file):

| Coordinate | Files (unsigned) | Bytes |
|---|---|---|
| `auto-mobile-sdk` | 30 | ~2.19 MB |
| `auto-mobile-protocol` | 30 | ~1.07 MB |
| `auto-mobile-junit-runner` | 30 | ~0.47 MB |
| `auto-mobile-test-plan-validation` | 30 | ~0.19 MB |

`auto-mobile-sdk`'s Javadoc jar alone is ~1.78 MB; the other three carry no
public API docs (~261 bytes each). Signing (enabled in release CI) adds a `.asc`
plus its four checksums for each signed primary, which is what brings a real
release to roughly 200 files.

## Caveats

- The local file repository also writes `maven-metadata.xml` per coordinate. The
  Central Portal bundle may regenerate metadata server-side, so the manifest can
  slightly over-count versus the final Central state. This is intentional: the
  manifest reflects what Gradle produces, and the relative before/after signal —
  the point of the oracle — is unaffected.
- The budget in `maven-usage-budget.json` is advisory and headroom-padded.
  Tighten `maxBytes` after #4851 and #4852 land, and raise the ceilings
  deliberately whenever a new coordinate is added.
