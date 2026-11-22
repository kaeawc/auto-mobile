# Material 3 Expressive components drawn from stable primitives

- Kind: decision
- Date: 2026-11-19
- Source: #15258
- Shaped: [Prototype controls](../how-it-works/plat/android/prototype-ux-controls.md)

## Context

The [availability check](2026-11-17-m3-expressive-component-availability.md) found that the pinned
Compose BOM resolves `material3` 1.4.0. That release has the Expressive tokens and motion scheme but
none of the components #15258 adds: button groups, split buttons, FAB menus, the loading indicator
and wavy progress. The issue asks that experimental components sit behind their own capability.

## Options

- Pin `material3` to a 1.5.0 pre-release and use the library components, with the loading indicator
  behind `prototype_m3_expressive_experimental_v1`.
- Wait for a BOM that maps to a stable `material3` 1.5.0.
- Draw the five components in the renderer from stable Compose primitives and the contract's
  expressive motion tokens.

## Decision

The renderer draws them from stable primitives. No experimental API is used, so all five ship behind
one stable capability, `prototype_m3_expressive_v1`, and `prototype_m3_expressive_experimental_v1`
is not introduced. Menus expand inline in the prototype window, as `menu` and `select` do, rather than
in a popup.

## Consequences

- The drawn components approximate the Material shapes; they are not the library components.
- Moving to the library components after a BOM bump changes pixels but not the contract.
- The iOS agent does not advertise the capability until its SwiftUI approximations exist.
