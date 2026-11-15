# Move to Zod 4 and override Jimp's Zod 3 range

- Kind: decision
- Date: 2026-11-15
- Source: #16102
- Shaped: [Runtime dependency pinning](../how-it-works/release/runtime-dependency-pinning.md)

## Context

Dependabot alert 90 (GHSA-mrhx-c7xc-m3w5) flags `zod` below 4.6.6: validating a large array with
no length constraint can exhaust memory. The repository pinned `zod@3.25.76`, which served both
its `zod/v4` imports and the Zod 3 API that the `@jimp/plugin-*` packages declare (`^3.23.8`,
Jimp 1.6.1). Oversized tool-argument arrays were already refused before the schema parse.

## Options

- Override Jimp's `zod` range onto a 4.x release, keeping one copy.
- Bundle `@jimp/plugin-*` with a nested Zod 3 and move only the direct pin. The alert may stay open.
- Replace Jimp, or wait for a Jimp release that accepts Zod 4.

## Decision

The owner chose the override. `zod` is pinned to 4.6.7 and `overrides.zod` lifts Jimp's range onto
it. Bare `zod` imports moved to `zod/v3`, which 4.x still ships, so their v3 behavior is unchanged.

Zod 4.6 changed behavior the tool contract depends on, and each change is undone where the repo
pins it:

- JSON Schema output spells nullable unions as `type` arrays, emits a non-standard `format` for
  `startsWith`-style checks, and extracts single-use schemas into `$defs`. The advertised-schema
  path restores the earlier `anyOf` spelling, drops those formats and inlines single-use
  definitions.
- A union whose only non-aborted arm failed on unknown keys returns that arm's issues. Selector and
  container unions mark unknown keys as aborting, so conflict diagnostics still see every arm.
- An intersection reports an unknown key only when both sides reject it. The `waitFor` presence
  intersections re-check the strict base's keys.
- Records and intersection merges drop an own `__proto__` key, in `zod/v4` and the bundled
  `zod/v3`. Prototype records that keep arbitrary authored names validate and restore that key.
- A non-finite number reports `received: "-Infinity"`, which the parameter formatter now names as
  non-finite.

## Consequences

The lock holds one `zod` copy at 4.6.7. Jimp's plugins run on Zod 4's v3-compatible API; the image
backend tests and a resize/crop/blur/diff smoke pass, but a device-backed screenshot and
`compareScreenshot` run is still the check that Jimp works end to end.
