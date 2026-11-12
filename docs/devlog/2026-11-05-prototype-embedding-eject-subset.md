# Eject scaffold covers a fixed node subset

- Kind: decision
- Date: 2026-11-05
- Source: moved from `how-it-works/prototype-embedding.md`; #16470
- Shaped: [Native prototype embedding](../how-it-works/prototype-embedding.md)

## Context

`automobile:prototype/eject` writes a one-shot Compose or SwiftUI scaffold with no renderer
dependency. Each node type it scaffolds needs an emitter per dialect.

## Options

Not recorded.

## Decision

The scaffolded subset is fixed: layout, text, buttons, fields, lists and `stack`. Every other node
type stays a stub rather than gaining emitters.

## Consequences

The subset's maintenance cost grows with every node type added to it, so it stays small. Stubs keep
their `testTag` and children, so the screen map and recorded flows still find them.
