# Prototype spec open follow-ups

- Kind: idea
- Date: 2026-10-09
- Source: moved from `how-it-works/plat/android/prototype-ux.md`; #10261, #10941, #12268, #12395,
  #14227, #14254, #14261, #15053, #15249, #15251, #15256, #15515, #15562, #15594, #15595, #15617
- Shaped: [Agent-authored prototype specification](../how-it-works/plat/android/prototype-ux.md)

## Planned or open work

- **Secure windows (#10261).** Foreground scoping does not detect secure windows because no trusted
  existing signal was found; detection was deferred.
- **Saved prototype storage on reinstall.** The #12268 host mirror records saved prototypes from
  what the host sent at `save`. Mirroring stored values would need a device-to-host export (a new
  wire message plus a `restoreSavedPrototypes` re-seed).
- **Icon effects.** Android uses a self-contained Compose animation with 600 ms cycles; it should
  move onto the #15249 keyframes engine when that is available.
- **Realtime channels (#14261).** Wiring `PrototypeChannelController` into the prototype runtime as
  the `realtime` module (calls, data writes including `upsertData`/`maxItems`), capability
  advertisement, foreground/background lifecycle, inspection and simulation.
- **Sound assets.** A literal `{asset: ...}` sound is refused until the audio asset type (#14254)
  lands.
- **Effects.** ProtoViewer shows no note when it degrades an effect; that is an open follow-up.
- **Value formatters (#14227).** `dateTime`, `duration`, `plural` and `fileSize` format kinds.
- **Glass on Android (#15256).** Real blur, the clear-variant approximation and ignored interactive
  semantics belong to the Android renderer slice; `scroll.edgeEffect` is accepted but not rendered
  until that slice.
- **Search bar.** The first pass (#12395) added only the shared contract and host, and required the
  later Compose implementation to use material3 `SearchBarDefaults.InputField` inside an in-tree
  `Surface`/`Column`, pinned to the material3 from `androidx-compose-bom`.
