# Arbitrary vehicle properties through car service injection

- Kind: decision
- Date: 2026-11-23
- Source: #19058
- Shaped: [Android form factors: Wear OS, Android Auto and Automotive](../how-it-works/plat/android/form-factors-wear-auto.md)

## Context

The vehicle conditions could set only gear, speed, parking brake and night mode. #19058 asked for a
`vehicle.property {id, areaId?, value}` condition. It writes with `cmd car_service inject-vhal-event`
and reads back with `cmd car_service get-property-value`. It accepts ids by number and by
`VehicleProperty` name, and keeps the refusal on user builds. The emulated vehicle HAL host side in
emu-rs uses it to check that values flow end to end.

AOSP car service was read at `android14-release` and `main`. There, `VehicleHal.injectVhalEvent`
hands the value to car service's own event dispatch. It does not call the vehicle HAL, which is what
`get-property-value` reads. `createPropValueForInjecting` parses each value by the id's type bits.

| Type          | Parsed with                         |
| ------------- | ----------------------------------- |
| BOOLEAN       | `Boolean.parseBoolean`              |
| INT32, INT64  | `Integer.decode`, `Long.decode`     |
| FLOAT         | `Float.parseFloat`                  |
| Vectors       | Each comma-separated item, as above |
| STRING, BYTES | Refused, as is MIXED                |

## Options

- Report success only when the read-back equals the injected value. On a stock emulator the vehicle
  HAL never stores the event, so every write would read as failed.
- Write through `cmd car_service set-property-value`, which does reach the vehicle HAL. The issue
  asked for the injection path, and set refuses read-only sensor properties such as
  `PERF_VEHICLE_SPEED`.
- Inject as asked, and report the injected and read-back values side by side.

## Decision

Inject as asked, then report `value`, `readBack` and `matches` in the change's `vehicleProperty`.
The status is `applied` once car service accepts the event. Values are encoded by the id's type bits,
so a BOOLEAN is sent as `true` or `false`. The name table covers the properties the issue listed, with
ids copied from `VehicleProperty.aidl`. Other properties take their numeric id.

## Consequences

`matches: false` is the expected result on a stock emulator, and the docs say so. A vehicle HAL that
stores injected values, such as an emulated host side, reads back `matches: true`. Reset re-injects
the value read before each property's first change, so it restores car service's view and leaves the
vehicle HAL as it was.
