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
even though it is not `import()`-ed from the bundle. Every other dependency
(`werift`, the MCP SDK, `zod`, …) is inlined into the bundle and is **not** needed
at install time. Those inlined packages therefore live in `devDependencies`;
consumers never install them, which is what removed the `@peculiar/asn1-*`
install path entirely.

## How the graph is pinned

The primary mechanism Bun honors for a consumer's `bun install -g` is **exact
top-level `dependencies`** (verified empirically). A published
`npm-shrinkwrap.json` is ignored by Bun. The graph is therefore flattened into
exact `dependencies` wherever a build-time version does not conflict, with a
small `bundledDependencies` set for the conflicting Jimp paths:

- **runtime roots** — `jimp`, `@jimp/core`, `sharp`, `kysely` — and every
  **pure-transitive** node of their closure are pinned to exact versions;
- **platform-native `@img/sharp-*`** binaries stay in `optionalDependencies`
  (already exact-pinned, resolved per platform);
- non-native `@img` transitives, including sharp's `@img/colour`, remain in
  `dependencies` and are exact-pinned like every other pure-transitive node;
- `@jimp/diff`, `@jimp/js-png`, `@jimp/plugin-blit`, and
  `parse-bmfont-xml` are bundled so their nested `pixelmatch`, `pngjs`,
  `xml2js`, and `zod` versions remain part of the published artifact instead of
  being resolved from later registry releases. The native `@img/sharp-*`
  binaries remain unbundled and platform-selected.

The selected bundle adds about 17 MiB to the package. The unpacked-size guard is
therefore 36 MiB: enough for the reproducible Jimp closure, but still a bounded
release contract.

The pinned graph is mirrored in `scripts/release/runtime-graph.json` (the
manifest) and enforced by:

| Guard                            | Where                                 | What it proves                                                                   |
| -------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| `pin-runtime-deps.ts --check`    | Fast Validation (`runtime-pins`)      | `package.json` + manifest are in lock-step with `bun.lock` (hermetic)            |
| `verify-pinned-runtime-graph.sh` | PR benchmarks job + release preflight | a clean-cache install of the **packed** artifact reproduces every exact and bundled runtime version |

## Refreshing the graph (dependency / security updates)

When a runtime dependency or a security override changes the resolved graph
(e.g. a Dependabot bump to `sharp`, `jimp`, or one of their transitives):

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
