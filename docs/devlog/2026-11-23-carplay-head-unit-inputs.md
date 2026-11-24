# CarPlay head-unit inputs on the simulator

- Kind: decision
- Date: 2026-11-23
- Source: #19059
- Shaped: [CarPlay prototypes](../how-it-works/plat/ios/carplay-prototypes.md)

## Context

CarPlay input on the simulator was touch only: the helper wrote a StarkConfig with `hasWheel`,
`hasBackButton` and `hasHomeButton` false, and `tapAt` was the only way in. Apps built for knob or
touchpad cars, and flows started from Siri or the back button, could not be driven. sim-rs
attaches the CarPlay display the same way and needs the same inputs.

A search of public sources found no CarPlay knob or button builder in SimulatorKit:

- A strings dump of Xcode 16 SimulatorKit lists every `IndigoHIDMessage*` export. The only CarPlay
  ones are `IndigoHIDMessageToCreateCarPlayService(BOOL)` and `IndigoHIDMessageToRemoveCarPlayService`
  ([keith/Xcode.app-strings, SimulatorKit](https://github.com/keith/Xcode.app-strings/blob/main/Xcode.app/Contents/Developer/Library/PrivateFrameworks/SimulatorKit.framework/Versions/A/SimulatorKit), lines 304-333). Its message struct has wheel and button
  event members, but no export fills them for CarPlay.
- Simulator.app's CarPlay window draws a wheel, select, back and home (`starkWheelAdjust:`,
  `tvOutWheelBumpSend`, `starkBackButton`, `starkHomeButton`;
  [keith/Xcode.app-strings, Simulator](https://github.com/keith/Xcode.app-strings/blob/main/Xcode.app/Contents/Developer/Applications/Simulator.app/Contents/MacOS/Simulator)). Nothing public says which messages those controls send. Finding out needs a
  disassembly of Simulator.app.
- The StarkConfig keys are width, height, scale, `stark`, `hasTouchScreen`, `hasTouchScreenLofi`,
  `hasBackButton`, `hasHomeButton`, `hasWheel`, `hasWheelBump` and `protocols` (Simulator.app
  strings). The only CarPlay mode properties are `SimCarPlayPropertyKeyStark` and
  `SimCarPlayPropertyKeyHasTouchScreen` ([lynnswap/NeoSimulator](https://github.com/lynnswap/NeoSimulator)).
- `IndigoHIDMessageForHIDArbitrary(target, usagePage, usage, op)` sends any HID usage to a target.
  idb documents that, for the phone, only target `0x32` acts on Consumer usages and `0x33` drops
  them silently ([facebook/idb `Indigo.h`](https://github.com/facebook/idb/blob/main/PrivateHeaders/SimulatorApp/Indigo.h)). Argus uses it for the tvOS
  focus engine ([DouweBos/Argus `ArgusHID.m`](https://github.com/DouweBos/Argus/blob/main/native/argus-sim-bridge/ArgusHID.m)).
- `IndigoHIDMessageForScrollEventFromHIDEventRef(IOHIDEventRef, target)` is the only export that
  carries a relative value to a chosen target. A serve-sim study found no visible scroll from it at
  the phone pointer target on iOS 27.0.
- The guest accepts only registered targets and aborts backboardd on others. Target `1` is the
  CarPlay service ([tddworks/baguette companion-screens design](https://github.com/tddworks/baguette/blob/main/docs/features/companion-screens/design.md)).
- `IndigoHIDMessageForButton` sends home, lock and Siri to the phone's button service, not to the
  CarPlay service (idb, NeoSimulator).

## Options

- Record every input as unreachable until someone disassembles Simulator.app.
- Send the standard Consumer-page usages a car knob and its buttons report, through the generic
  builders, to the registered CarPlay target, and verify them on a simulator.
- Hand-build Indigo wheel and button messages from the struct layout.
- Send phone buttons (`IndigoHIDMessageForButton`) and hope CarPlay mirrors them.

## Decision

Send the inputs to target `1` through the generic builders. Back, home, Siri, knob select and the
nudges are Consumer usages, each pressed and released. They are AC Back `0x224`, AC Home `0x223`,
Voice Command `0xCF`, Menu Pick `0x41` and Menu Up, Down, Left and Right `0x42`-`0x45`. Knob rotation
is one `IOHIDEventCreateScrollEvent` per detent. Target `1` is registered, so a usage CarPlay ignores
is dropped rather than crashing the guest.

The StarkConfig flags are opt-in (`startDevice` `carPlay.headUnitInputs`, `power-on
--head-unit-inputs`), so the verified touch-only power-on does not change. Each input needs the flag
for its hardware; Siri has no StarkConfig key.

No mapping has been run on a simulator yet. This change was written on a Linux host with no iOS
simulator.

## Consequences

- `pressButton` with `display: "carPlay"` reports what was sent, not whether CarPlay acted.
- Verify each input on an iOS 26.x simulator, with the CarPlay screen captured before and after.
  Fix the mapping in one place (`CarPlayInput.message`) or record the input as unreachable.
- If none of the usages act, the next step is to disassemble Simulator.app's `starkWheelAdjust:`
  and button handlers.
