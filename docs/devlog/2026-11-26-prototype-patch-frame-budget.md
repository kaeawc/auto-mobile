# Prototype patch frames follow the runtime budget

- Kind: decision
- Date: 2026-11-26
- Source: #19306
- Shaped: [Prototype UX envelope](../how-it-works/plat/android/prototype-ux-envelope.md)

## Context

#18804 let a runtime advertising `prototype_large_budget_v1` take a 4 MiB spec with 3 MiB of data.
The host still capped every `patch_prototype` frame at the base 1 MiB spec limit, so a patch that
replaced most of a large prototype's `/data` was refused before the device saw it. The issue also
asked whether the handshake should carry the budget's numbers.

## Options

- Keep the 1 MiB frame cap for every runtime.
- Cap the frame at the spec byte limit of the budget the prototype runs under.
- Send the budget's numbers in the handshake.

## Decision

The frame cap is the `MAX_PROTOTYPE_SPEC_BYTES` of the budget the spec was shown under. For a
disposable app, which owns its spec, it is the budget the app advertises. A frame over the large
budget is refused before it waits in the patch queue. The handshake keeps carrying only the
capability name, because host and device read the same `runtimeBudgets` table.

## Consequences

A base-budget runtime keeps the 1 MiB cap. The refusal names the frame size, the limit and the
capability that raises it. ProtoViewer bundles and Android saved layouts still cap `spec.json` at
1 MiB until their Kotlin and Swift readers follow the large budget (#19306).
