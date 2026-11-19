# Defer Apple Watch prototypes

- Kind: decision
- Date: 2026-11-07
- Source: #16835 (owner decision, 2026-11-07); epic #14895; counterpart of #14934 and #16747
- Shaped: [Apple Watch prototypes](../how-it-works/plat/ios/watch-prototypes.md)

## Context

The `prototype` tool is refused on a watch. Watch-sized mockups render on a phone instead (#14905).
The question was whether agent-authored prototypes should run on the watch itself, and how.

## Options

| Option                             | Fidelity                                                                     | Spec impact                                                                                                 | Test strategy                                                           | Maintenance                                        |
| ---------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------- |
| 1. Phone-hosted watch-sized mockup | Low: watch-sized look on a phone, no crown or round display                  | None                                                                                                        | Existing renderer tests                                                 | None beyond today's renderers                      |
| 2. watchOS prototype agent         | Shared vocabulary on the watch, with round and crown input                   | None: a SwiftUI renderer in a host watch app reuses the iOS agent's spec handling                           | Watch runner and the advisory watch simulator CI (#14913); not measured | A new host watch app and renderer                  |
| 3. Watch-specific spec nodes       | Watch idioms: crown-driven picker, vertical page list, complications preview | New nodes shared with Wear OS prototypes (#14907), across the TS, Kotlin and Swift validators and renderers | Not recorded                                                            | Three validators and renderers track the new nodes |
| 4. Defer                           | n/a                                                                          | None                                                                                                        | None                                                                    | None                                               |

## Decision

Defer (option 4). Keep the watch-sized mockup on a phone, with no spec, validator or renderer
changes. The source gives no further reason.

## Consequences

A spec cannot target an Apple Watch, and this record files no follow-up issues. Revisit when there
is demand. The source leaves these open for the owner to decide then:

- What counts as demand, and who records it.
- Whether option 3 waits for, or is shared with, a Wear OS decision on watch-specific nodes (#14907
  shipped show and dismiss on Wear OS without them).
- Whether the advisory watch simulator CI (#14913) must exist before option 2 is built.
