# Per-runtime prototype budgets

- Kind: decision
- Date: 2026-11-19
- Source: #18804, measurements on #14183
- Shaped: [Prototype spec: envelope and data model](../how-it-works/plat/android/prototype-ux-envelope.md)

## Context

One set of limits applied to every runtime. At about 540 bytes per row, the 1 MiB spec cap binds at
about 1900 rows, so the 2000-row list cap was already at the byte cap. The overlay runs in the
accessibility service process. Activity-hosted runtimes (disposable app, ProtoViewer, an embedding
app) run in their own process.

The #14183 runs used a pixel_6a API 35 emulator with 3 GB and a 10x contract. The first run had a
host load of about 300 and a software GPU. The re-run had a low load and `-gpu host`. Frame time was
flat in row count: p50 was 17 ms at 2000, 4000, 10000 and 20000 rows, and scroll p95 was 32, 32, 21
and 30 ms. Native heap grew linearly at about 6.3 MB per 1000 rows: 88.6 MB at 10000 rows and
140.8 MB at 20000. A 10000-row spec is 2.7 MB. Neither run measured nodes, images or depth at 10x,
a Pixel 10 Pro, or iOS.

## Options

- Keep one budget for every runtime.
- Raise the shared budget for every runtime, overlay and iOS agent included.
- Add a per-runtime budget behind a capability, with the overlay keeping today's limits.
- Admit 10x (20000 rows): the frame time showed no regression, but native heap rose by 115 MB over 1x.

## Decision

An activity-hosted runtime advertises `prototype_large_budget_v1` and gets 10000 list items and data
array items, 4 MiB of spec and 3 MiB of data and data writes. The overlay and the iOS agent keep
2000 items, 1 MiB and 768 KiB. The limits for nodes, depth and images per screen do not change. The
raised values live only in the contract's `runtimeBudgets` table. Each `maxItems` rule names the limit
its bound follows.

## Consequences

- The host checks a spec against the target runtime's budget, not against constants. Tool input
  admits the large budget. The show preflight and `requiredPrototypeCapabilities` then require the
  capability for any spec over the base budget.
- The Kotlin validator and the runtime's state and data writes take a budget. The overlay uses the
  base budget and the embedded renderer uses the large one. The Swift validator ignores
  `maxLimit` and keeps the base values.
- 20000 rows can be revisited if a use case appears. It is a question of heap only.
