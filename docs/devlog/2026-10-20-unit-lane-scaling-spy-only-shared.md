# Spy-only unit files in the shared process

- Kind: decision
- Date: 2026-10-20
- Source: moved from `how-it-works/ci/unit-lane-scaling.md`; #13568, #13854, #13865
- Shaped: [Unit lane scaling](../how-it-works/ci/unit-lane-scaling.md)

## Context

The 2026-10-08 study put every file with a `spyOn(` signal (554 files) in tier B, isolated, because
sharing spy files leaked spy state at once.

## Options

Not recorded.

## Decision

On 2026-10-20 (#13568 / #13854) the owner allowed spy-only files into tier C when the classifier proves
**every** spy is restored (#13865). Other signals still force isolation. There is no blanket restore
preload: it breaks suites that deliberately retain spies.

## Consequences

The study's section 2 table and measurements predate this decision.
