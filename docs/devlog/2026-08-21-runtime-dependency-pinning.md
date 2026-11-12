# Pinning the published runtime dependency graph

- Kind: decision
- Date: 2026-08-21
- Source: moved from `how-it-works/release/runtime-dependency-pinning.md`; #5421, #5423, #6820, #8330
- Shaped: [Runtime dependency-graph pinning](../how-it-works/release/runtime-dependency-pinning.md)

## Context

`bun install -g` re-resolves the published `dependencies` from their version ranges at install time.
With caret ranges, an unchanged release can start selecting dependency versions that did not exist
when it was published. On 2026-08-20 a staged `@peculiar/asn1-*@2.9.4` publish made clean installs of a
fixed `@kaeawc/auto-mobile` version fail transiently with `No version matching "^2.9.4" found` until
every matching version became resolvable (#5421).

## Options

- A published `npm-shrinkwrap.json`: Bun ignores it.
- Exact top-level `dependencies`: the mechanism Bun honors (verified empirically).

## Decision

Pin the runtime graph as exact top-level `dependencies` (#5423), with `bundledDependencies` only where
versions conflict, and move every package that is not needed at install time to `devDependencies`.
That removed the `@peculiar/asn1-*` install path entirely. `kysely` was kept as a runtime root
conservatively because of the `AUTOMOBILE_MIGRATIONS_DIR` override; dropping it is a separate
runtime-graph change.

## Consequences

- `sharp` and every `@img/*` entry are bumped by hand: Dependabot PR #6820 bumped only some of sharp's
  24-entry native matrix, left six behind, and sharp stopped loading on linux-x64.
- `bun install` can retain a stale nested lockfile entry; #8330 retained
  `file-type/uint8array-extras@1.5.0` after hoisting `uint8array-extras@1.6.0`. No pruner was added;
  the gate fails and a human prunes it.
