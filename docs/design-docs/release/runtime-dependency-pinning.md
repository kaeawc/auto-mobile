# Runtime dependency-graph pinning

AutoMobile publishes a **pinned runtime dependency graph** so that a clean
`bun install -g @kaeawc/auto-mobile@<version>` resolves the same versions no
matter what compatible releases appear in the registry afterward (issue #5421).

## The problem it solves

`bun install -g` re-resolves the published `dependencies` from their version
ranges at install time. With caret ranges, an unchanged release can start
selecting dependency versions that did not exist when it was published. On
2026-08-20 a staged `@peculiar/asn1-*@2.9.4` publish made clean installs of a
fixed `@kaeawc/auto-mobile` version fail transiently with
`No version matching "^2.9.4" found` until every matching version became
resolvable. A fixed release must resolve a fixed graph.

## Why the graph is small

`build.ts` bundles the server into a single `dist/src/index.js`, externalizing
**only** the image backends it loads from `node_modules` at runtime — the `jimp`
family (`jimp`, `@jimp/core`) and the `sharp` family (`sharp` + the platform
`@img/sharp-*` binaries). One more package is a runtime dependency without being
in that bundle: **`kysely`**. The DB migration `.ts` files are copied verbatim
into `dist/` and loaded from disk at runtime (via `AUTOMOBILE_MIGRATIONS_DIR`),
and each imports `kysely`'s `sql` tag — so `kysely` is the fourth runtime root
even though it is not `import()`-ed from the bundle.

The server uses the `zod/v4` subpath exported by **`zod@3.25.76`**. It remains
bundled into `dist/`, while the exact root package is also published so every
Jimp `zod: ^3.23.8` edge resolves to the same pinned version. Every other
inlined package (`werift`, the MCP SDK, …) is not needed at install time and
lives in `devDependencies`; consumers never install them, which is what removed
the `@peculiar/asn1-*` install path entirely.

## How the graph is pinned

The primary mechanism Bun honors for a consumer's `bun install -g` is **exact
top-level `dependencies`** (verified empirically). A published
`npm-shrinkwrap.json` is ignored by Bun. The graph is therefore flattened into
exact `dependencies` wherever a build-time version does not conflict, with a
small `bundledDependencies` set for the conflicting Jimp paths:

- **runtime roots** — `jimp`, `@jimp/core`, `sharp`, `kysely` — and every
  **pure-transitive** node of their closure are pinned to exact versions;
- **shared Jimp validator** — `zod@3.25.76` is a direct exact pin. AutoMobile
  imports its `zod/v4` subpath, so the bundled server retains the v4 API while
  Jimp's v3-compatible ranges cannot re-resolve;
- **platform-native `@img/sharp-*`** binaries stay in `optionalDependencies`
  (already exact-pinned, resolved per platform);
- non-native `@img` transitives, including sharp's `@img/colour`, remain in
  `dependencies` and are exact-pinned like every other pure-transitive node;
- `@jimp/diff`, `@jimp/js-png`, and `parse-bmfont-xml` are bundled so their
  nested `pixelmatch`, `pngjs`, and `xml2js` versions remain part of the
  published artifact instead of being resolved from later registry releases.
  The clean-room gate verifies each bundled owner path, including nested
  dependency paths, not merely that one matching residual exists somewhere in
  the package. The native `@img/sharp-*` binaries remain unbundled and
  platform-selected.

The selected bundle adds about 17 MiB to the package. Source maps no longer embed
sources by default; opt out for local debugging with
`AUTOMOBILE_SOURCEMAP_STRIP_SOURCES=false bun run build`.
The unpacked-size guard assumes trimming is enabled: 21 MiB (22,020,096 bytes).
On 2026-10-05, staged `npm pack --dry-run --json` measured 18,345,761 trimmed
bytes; adding 3 MiB and rounding up to a whole MiB sets the cap (#9571).
The same staging copy measured 23,838,787 bytes untrimmed for reference. It used
the worktree's existing `dist/`, schemas, package metadata, README, pack hooks,
and complete bundled dependency closure; the worktree's `node_modules` was untouched.

The pinned graph is mirrored in `scripts/release/runtime-graph.json` (the
manifest) and enforced by:

| Guard                            | Where                                  | What it proves                                                                                                                        |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pin-runtime-deps.ts --check`    | Fast Validation (`runtime-pins`)       | `package.json` + manifest are in lock-step with `bun.lock` (hermetic)                                                                 |
| `verify-pinned-runtime-graph.sh` | PR Node Checks job + release preflight | a clean-cache install of the **trimmed packed** artifact reproduces every runtime version and imports each importable bundled package |

## CI pack trimming

The prepack hook moves unused sources, declarations, maps, tests, docs and
verified browser-only files out of the bundled production dependency closure.
Runtime entry points, wildcard export prefixes, package metadata, README and
license files stay intact. Postpack restores the original bytes; the next enabled
prepack also restores any backup left by an interrupted pack.

`AUTOMOBILE_TRIM_BUNDLED_DEPS=true` enables trimming; `false` disables it.
Otherwise trimming runs only with `CI=true` or `CI=1`. Local `npm pack` is
untrimmed by default. The unpacked-size benchmark and clean-room graph gate
explicitly enable trimming, including locally, so they enforce the same trimmed
cap and runtime imports as CI. The import smoke resolves each dependency by name
beside its own installed directory under Bun's export conditions, including
nested duplicate versions. Packages with no runtime entry or only a bin and no
importable entry are skipped by metadata/file rules, and every skip is printed.
AutoMobile's own server entry point is never imported. All hook diagnostics go
to stderr to preserve pack JSON.

## Refreshing the graph (dependency / security updates)

### Automatic refresh on Dependabot PRs

`.github/workflows/dependabot-runtime-pins.yml` handles opened, synchronized,
and reopened Dependabot PRs touching `package.json` or `bun.lock`. Both jobs
require the `dependabot[bot]` actor and a head repository matching this repository.
They use read-only permissions, bounded timeouts, and checkouts that disable LFS
and persist no credentials. All actions are pinned to full commit SHAs.

The **regenerate** job checks out the exact PR head SHA, installs dependencies,
builds, runs `pin-runtime-deps.ts --write`, installs again, and formats. It receives
no secrets. It runs `--check` before uploading an artifact containing only
`package.json`, `bun.lock`, and `scripts/release/runtime-graph.json`, preserving
their repository-relative paths. A failed check fails the job: no artifact is
uploaded and the dependent push job does not run. The artifact name includes the
PR number, run ID, and run attempt; retention is one day.

The split addresses a specific threat: lifecycle scripts and dependency code
executed on the PR runner can rewrite the commit script, plant Git hooks, change
Git config, shadow commands through `PATH`/`GITHUB_PATH`, or poison later steps
through `GITHUB_ENV` (for example `BASH_ENV` or loader variables). A final-step
secret in that same job would still be exposed to the tampered environment.

The **push** job uses a fresh runner, never executes PR code, and restores no
cache. It sparse-checks out the trusted commit script from the repository's
**default branch** into a separate directory and downloads only the named
artifact. Only the final trusted script step receives `AUTO_MOBILE_PR_TOKEN` via
its environment. The script validates the artifact as data: exactly three
regular files and the necessary directories, no symlinks, hardlinks, extra paths
or dotfiles, a 20 MiB cap per file (well above current pin-file sizes), and one
JSON object each for the package and graph manifests, parsed with `jq`.

The script creates a temporary repository with templates disabled, ignores
global/system Git config, and disables hooks, filesystem monitors, external
protocol helpers, credential helpers, and commit signing on every Git invocation.
It fetches only the PR branch and verifies that its head still equals the starting
SHA. It populates only the index, never the PR working tree, avoiding PR symlinks
while copying the three validated files. It stages their exact bytes with
`hash-object --no-filters` and `update-index --cacheinfo`, bypassing PR attribute
filters and encoding conversions; directory conflicts fail without pushing. It
commits as `github-actions[bot]` and uses a normal fast-forward push; concurrent
branch updates are rejected. No changes produce a successful notice. The raw
PAT and its base64 encoding are registered with Actions masking; authentication
uses an HTTP extraheader supplied through `GIT_CONFIG_COUNT` environment entries,
never a remote URL, command argument, or persisted Git configuration. The temporary
repository is removed on exit.

The trigger is `pull_request`, not `pull_request_target`: dependency code runs
with read-only permissions rather than a privileged base-repository context.
The separate runner and trusted default-branch script isolate the PAT from that
code. The PAT remains a repository-write credential. A malicious change to the
three files can still be pushed **as data**: these are the dependency changes
Dependabot proposed plus regenerated pins, and normal review and CI still apply.
Artifact validation is structural only; it does not establish that the dependency
content or regenerated pins are safe or semantically correct. The regenerate
runner can tamper with its own check and artifact, so its check is a correctness
gate, not a security attestation. The default branch and pinned actions remain
part of the trusted boundary.

**Owner setup:** configure the existing `AUTO_MOBILE_PR_TOKEN` PAT in this
repository's **Dependabot secrets** store too, with branch push access. Dependabot
`pull_request` runs receive Dependabot secrets, not Actions secrets. Missing
configuration produces a clear error even when the artifact has no changes.
The trusted script must first be present on the default branch before this
workflow can use it. The default `GITHUB_TOKEN` is read-only here and its pushes
would not retrigger CI. The PAT follow-up commit retriggers `pull_request` CI,
giving the new head fresh required checks. That run's actor is the PAT owner,
so the Dependabot-only guard prevents a loop. No skip-CI marker is used.

A human/PAT push makes Dependabot stop auto-rebasing that PR. Use
`@dependabot recreate` when it needs to be regenerated; Dependabot's new update
reruns this workflow.

Real version conflicts still need human intervention, as do coordinated
`sharp`/`@img` updates ignored by `.github/dependabot.yml`. There is no new
nested-lockfile-entry pruner: although `bun install` runs, it may retain a stale
redundant nested entry. For example, #8330 retained
`file-type/uint8array-extras@1.5.0` after hoisting `uint8array-extras@1.6.0`.
If regeneration or `--check` reports
`Residual runtime dependency owners are not bundled: file-type`, the job fails
loudly and a human must prune the redundant entry and refresh the graph.
Reviewing `.github/dependabot.yml` ignore rules after this workflow lands is a
follow-up; this change leaves those rules unchanged.

### Manual refresh

When a runtime dependency or a security override changes the resolved graph
(e.g. a Dependabot bump to `jimp` or one of their transitives, or a manual
`sharp` bump):

> `sharp` and every `@img/*` entry are ignored in `.github/dependabot.yml` and
> must be bumped by hand. Dependabot bumps only the entries eligible when it
> opens the PR, which splits sharp's 24-entry native matrix (PR #6820 left six
> behind and sharp stopped loading on linux-x64), and it cannot regenerate
> `scripts/release/runtime-graph.json`. Bump `sharp` together with every
> `@img/sharp-*` / `@img/sharp-libvips-*` pin, then follow the steps below;
> `scripts/check-sharp-matrix-coherence.ts` rejects a partial bump.

1. Update the version(s) as usual and run `bun install` so `bun.lock` reflects
   the new resolution.
2. Rebuild so the roots derivation reads the current bundle:
   ```bash
   bun run build
   ```
3. Regenerate the pinned graph and manifest:
   ```bash
   bun scripts/release/pin-runtime-deps.ts --write
   bun install            # refresh bun.lock for any newly-direct pins
   ```
4. Commit `package.json`, `bun.lock`, and `scripts/release/runtime-graph.json`
   together.
5. Confirm locally before pushing:
   ```bash
   bun scripts/release/pin-runtime-deps.ts --check
   bash scripts/ci/verify-pinned-runtime-graph.sh
   ```

If the clean-room gate reddens, regenerate the manifest and inspect the packed
tree before publishing. A bundled or exact runtime version changing without that
refresh is a release failure, not an expected registry update.
