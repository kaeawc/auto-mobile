# No consumer keep rule for prototype icons

- Kind: decision
- Date: 2026-11-23
- Source: moved from `using/prototype-embedding.md`; #19107
- Shaped: [Embedding a prototype in an app](../using/prototype-embedding.md)

## Context

The Compose prototype renderer looks up Android icons named in a spec by reflection, which R8
cannot see. A minified app that renders icons by name loses them unless a keep rule retains them.

## Options

Not recorded.

## Decision

The renderer library ships no consumer keep rule for icons. A consumer rule would retain all of
`material-icons-extended`, about 3 MB of dex, in every app that uses the library.

## Consequences

An app that minifies and renders icons by name adds the keep rule itself, narrowed to the icons
its specs use when size matters. Apps that never shrink, and specs without icons, need no rule.
