# XR headset hand and eye input over emulator gRPC

- Kind: decision
- Date: 2026-11-23
- Source: #19057
- Shaped: [XR headset host input](../how-it-works/plat/android/xr-host-input.md)

## Context

On the Android XR headset emulator, AutoMobile reached panel content only through accessibility
node clicks. Display touches on a Compose `SpatialPanel` are refused, and no tool sent hand or eye
input. The emu-rs emulator mirrors the stock emulator's console and adb, so it needed to know which
host surface carries that input to offer the same one.

## Options

- Emulator console (`adb emu`): `console.cpp` on `emu-main-dev` has no XR, hand or gaze command.
- adb `input` and in-guest shells: `cmd xrsimulatedinputmanager` has no shell implementation
  (#16843), and `input` has no hand or gaze source.
- gRPC `EmulatorController.streamInputEvent`: since emulator 35.4, `InputEvent` carries
  `xr_hand_event` (7) and `xr_eye_event` (8), both a `MouseEvent`. Android Studio's embedded
  emulator sends its hand and eye input modes this way.
- The emulator's input-mode and hand-gesture messages (left hand, grab, poke): sent only by its Qt
  toolbar, with no gRPC route.

## Decision

Add the opt-in `xrHeadsetInput` tool. It sends Studio's event sequences on `streamInputEvent`,
reusing the emulator gRPC discovery, auth and HTTP/2 transport that audio injection uses. It is
refused on devices not confirmed as XR headsets. The tool covers select (aim, press, release),
point (aim only) and a hand pinch-drag.

## Consequences

- The host interface is written down for other emulators in
  [XR headset host input](../how-it-works/plat/android/xr-host-input.md).
- The stream returns no acknowledgement, so results come from `observe`, not from the call.
- The tool is unit-tested only. It was not run on a headset emulator: the session that built it
  had no KVM and no emulator farm. The
  [headset matrix](../how-it-works/plat/android/xr-headset.md#matrix) marks it untested.
- The same `InputEvent` carries head rotation, movement and recenter. These are recorded for #18416
  and not sent.
