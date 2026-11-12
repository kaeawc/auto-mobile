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

`build.ts` bundles the server into `dist/src/index.js` plus code-split
`dist/src/chunk-*.js` siblings, externalizing
**only** the image backends it loads from `node_modules` at runtime — the `jimp`
family (`jimp`, `@jimp/core`) and the `sharp` family (`sharp` + the platform
`@img/sharp-*` binaries). One more package is a runtime dependency without being
in that bundle: **`kysely`**. Migrations are bundled through static imports.
`kysely` is kept as a runtime root conservatively: `kysely` is bundled, but an
`AUTOMOBILE_MIGRATIONS_DIR` override loads raw migrations that import `kysely`'s
`sql` tag, and such a folder resolves it from its own location. Dropping the root
is a separate runtime-graph change.

The server uses the `zod/v4` and `zod/v3` subpaths exported by **`zod@4.6.7`**
(`zod/v3` keeps the v3 API for schemas written against it). It remains bundled into
`dist/`, while the exact root package is also published. Jimp's `@jimp/plugin-*`
packages declare `zod: ^3.23.8`; a root `overrides.zod` entry lifts those edges onto the
same 4.x version, so the lock holds one zod copy below no patched floor. Every other
inlined package (`werift`, the MCP SDK, `@anthropic-ai/sdk`, …) is not needed at install time and
lives in `devDependencies`; consumers never install them, which is what removed
the `@peculiar/asn1-*` install path entirely.

## How the graph is pinned

The primary mechanism Bun honors for a consumer's `bun install -g` is **exact
top-level `dependencies`** (verified empirically). A published
`npm-shrinkwrap.json` is ignored by Bun. The graph is therefore flattened into
exact `dependencies` wherever a build-time version does not conflict, with a
small `bundledDependencies` set for the conflicting Jimp paths:

- **runtime roots** — `jimp`, `@jimp/core`, `sharp`, `kysely`, and
  `@material-design-icons/svg` (read from disk through `import.meta.resolve`, which
  the roots derivation counts like a dynamic import) — and every
  **pure-transitive** node of their closure are pinned to exact versions;
- **shared Jimp validator** — `zod@4.6.7` is a direct exact pin, and `overrides.zod`
  holds Jimp's `^3.23.8` ranges on it. Jimp's plugins call only the zod API shared by
  v3 and v4 (`z.object`, `z.number`, `z.union`, …);
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

The selected bundle adds about 17 MiB to the package. Source maps do not embed sources by default
(opt out locally with `AUTOMOBILE_SOURCEMAP_STRIP_SOURCES=false bun run build`) and external source
maps are excluded from the tarball (unused at runtime). The unpacked-size guard runs on the trimmed
pack and is capped at 20,132,659 bytes (16 MiB + 20%; #9571, #12457); a pack with source maps restored
(23,061,125 bytes) fails, and an untrimmed pack is larger still.

Code splitting (#17683) lets startup parse only the chunks it loads; code behind a
dynamic `import()` stays unparsed until first use. Chunks are hashed siblings of
`index.js`, so `import.meta.url`-relative lookups still resolve from `dist/src`.
The roots derivation scans each chunk the way it scans `index.js`. Because chunk
names cannot be listed statically, the packed-asset guard (unpacked-size benchmark
and artifact identity) walks every relative `import`/`import()`/`import.meta.require`
from the packed entrypoints and fails on any target missing from the tarball. ESM
evaluates a module's own body only after all of its static imports, so `build.ts`
also lists the Bun runtime guard and the launcher-pid capture (#11041) as
entrypoints. That gives each one its own dependency-free chunk. The build then
fails unless `index.js` imports those chunks first, in that order.

Feature-gated modules stay off that startup path: the prototype tool's runtime and
resource readers, the in-process MCP client, the Claude vision client (`@anthropic-ai/sdk`)
and the WebRTC publisher (`werift`) are imported on first use through
`src/utils/lazyFeatureModule.ts`, which logs each first load's latency. Their tools,
resources and schemas are still registered at startup, so `tools/list` and
`resources/list` are unchanged. A failed import is not memoized: the call that hit it
gets an `ActionableError` and the next call imports again. Prototype resource-update
notifications need only the revision store, never the readers, so a failed reader import
cannot drop one. `test/lint/lazyFeatureModules.integration.test.ts`
fails if a static import pulls one back onto the startup path.

The pinned graph is mirrored in `scripts/release/runtime-graph.json` (the
manifest) and enforced by:

| Guard                            | Where                                  | What it proves                                                                                                                        |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pin-runtime-deps.ts --check`    | Fast Validation (`runtime-pins`)       | `package.json` + manifest are in lock-step with `bun.lock` (hermetic)                                                                 |
| `verify-pinned-runtime-graph.sh` | PR Node Checks job + release preflight | a clean-cache install of the **trimmed packed** artifact reproduces every runtime version and imports each importable bundled package |

## CI pack trimming

The prepack hook moves files out of the bundled production dependency closure
only when they belong to a class in the `PRUNE_CLASSES` allowlist
(`scripts/release/trim-bundled-deps.ts`): declarations, source maps, tests,
docs/markdown, TypeScript sources, `src/` beside a built `dist/`, browser-only
builds (`browser` field and `browser` export-condition targets, `dist/browser/`,
UMD) and CI/build tooling config. Bun and Node never resolve the `browser`
condition. Package metadata and legal notices (LICENSE, NOTICE, COPYING, PATENTS,
AUTHORS) are never removed. Runtime entry points and wildcard export prefixes are
protected, except that declarations and maps are pruned inside wildcard prefixes
because nothing loads them. A candidate that any retained JS file names literally
stays. `trim-bundled-deps.ts list` prints each candidate with its class. Postpack
restores the original bytes; the next enabled prepack also restores any backup
left by an interrupted pack.

The unpacked-size benchmark also enforces a byte budget for the packed
`node_modules/` (`BUNDLED_NODE_MODULES_MAX_BYTES` in
`scripts/build/packed-runtime-assets.ts`) and fails on any packed bundled
declaration or map, so a pack that skipped or weakened the prune fails.

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

The **regenerate** job checks out the exact PR head SHA, installs, builds, runs
`pin-runtime-deps.ts --write`, installs again, formats, and runs `--check` before uploading an
artifact holding only `package.json`, `bun.lock` and `scripts/release/runtime-graph.json` (repo-relative
paths; name includes PR number, run ID and attempt; one-day retention). It receives no secrets. A
failed check fails the job, so no artifact is uploaded and the push job does not run.

The split exists because lifecycle scripts and dependency code on the PR runner can rewrite the
commit script, plant Git hooks, change Git config, shadow commands via `PATH`/`GITHUB_PATH`, or
poison later steps via `GITHUB_ENV` (`BASH_ENV`, loader variables); a secret in that same job would
be exposed to the tampered environment.

The **push** job uses a fresh runner, never executes PR code, and restores no cache. It sparse-checks
out the trusted commit script from the **default branch** and downloads only the named artifact. Only
the final script step receives `AUTO_MOBILE_PR_TOKEN`. The script:

- validates the artifact as data: exactly three regular files plus needed directories, no symlinks,
  hardlinks, extra paths or dotfiles, a 20 MiB cap per file, and one JSON object each for the package
  and graph manifests (parsed with `jq`);
- builds a temporary repository with templates disabled, global/system config ignored, and hooks,
  filesystem monitors, external protocol helpers, credential helpers and signing disabled on every Git call;
- fetches only the PR branch and verifies its head still equals the starting SHA;
- populates only the index (never the PR working tree), staging exact bytes with
  `hash-object --no-filters` and `update-index --cacheinfo` to bypass attribute filters and encoding
  conversions; directory conflicts fail without pushing;
- commits as `github-actions[bot]` and does a normal fast-forward push (concurrent updates are rejected;
  no changes is a successful notice);
- masks the raw PAT and its base64 form, authenticates via an HTTP extraheader through
  `GIT_CONFIG_COUNT` env entries (never a URL, argument or persisted config), and removes the temp repo on exit.

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

**Owner setup:** configure the existing `AUTO_MOBILE_PR_TOKEN` PAT in this repository's **Dependabot
secrets** store too, with branch push access (Dependabot `pull_request` runs receive Dependabot
secrets, not Actions secrets). Missing configuration errors clearly even when the artifact has no
changes. The trusted script must already be on the default branch. The default `GITHUB_TOKEN` is
read-only here and its pushes would not retrigger CI; the PAT follow-up commit retriggers
`pull_request` CI with fresh required checks, and its actor (the PAT owner) means the Dependabot-only
guard prevents a loop. No skip-CI marker is used. A human/PAT push makes Dependabot stop auto-rebasing
that PR; use `@dependabot recreate` to regenerate.

Real version conflicts still need human intervention, as do coordinated
`sharp`/`@img` updates ignored by `.github/dependabot.yml`. There is no new
nested-lockfile-entry pruner: although `bun install` runs, it may retain a stale
redundant nested entry. For example, #8330 retained
`file-type/uint8array-extras@1.5.0` after hoisting `uint8array-extras@1.6.0`.
If regeneration or `--check` reports
`Residual runtime dependency owners are not bundled: file-type`, the job fails
loudly and a human must prune the redundant entry and refresh the graph.

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
