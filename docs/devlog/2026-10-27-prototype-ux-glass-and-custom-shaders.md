# Prototype glass surfaces and custom AGSL shaders

- Kind: decision
- Date: 2026-10-27
- Source: moved from `how-it-works/plat/android/prototype-ux.md`; #15244, #15256, #15562, #15617
- Shaped: [Agent-authored prototype specification](../how-it-works/plat/android/prototype-ux.md)

## Context

Two owner decisions bounded prototype surface effects: what `style.surface: "glass"` may draw, and
whether a spec may carry shader code at all. The spec otherwise accepts no code.

## Options

Not recorded.

## Decision

- **Glass (2026-10-27).** `style.surface: "glass"` requires real glass and `prototype_glass_v1`:
  iOS 26+ Liquid Glass, and Android API 31+ real backdrop blur once its renderer exists. iOS 17–25
  and Android below API 31 refuse glass by not advertising the capability. There is no simulated
  translucent fill, `ultraThinMaterial` substitute or fallback capability. Android rendering and
  device verification remain with the Android renderer slice.
- **Custom shaders (2026-10-26).** Android-only custom AGSL shaders require
  `prototype_custom_shaders_v1` and the host opt-in `AUTOMOBILE_PROTOTYPE_CUSTOM_SHADERS=1` (off by
  default). Source assets use `application/vnd.automobile.agsl`, valid UTF-8, at most 16 KiB, with
  at most 16 scalar `uniform float name;` declarations and one optional `uniform shader content;`,
  so only the node's own rendered content may be sampled. The lexical rules, reserved names and
  uniform value range are the contract in the shaped page. The Android runtime compiles on
  `put_prototype_asset` before retaining source and caps returned errors at 2 KiB of UTF-8.
  Execution fails closed under the frame-budget guard. iOS agents and ProtoViewer bundle
  import/export refuse both the MIME type and `style.shader`.

## Consequences

Glass and shaders stay capability-gated with no degraded rendering path. The shared validators
enforce the shader lexical rules on the host and the device.
