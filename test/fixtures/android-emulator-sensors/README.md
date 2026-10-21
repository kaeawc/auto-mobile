# Android emulator `sensor` console fixtures

**Hand-reconstructed, not captured from a device.** No emulator was available when
these were written (#14114). Each file reproduces what `adb -s <serial> emu sensor …`
prints, reconstructed from the emulator console's `sensor get`/`sensor set` handlers
(`<name> = a[:b[:c]]` with each value printed by `%g`, then the `OK` that `adb emu`
relays) and from the acceleration read-back reported in #10250. Values other than
acceleration are plausible, not the emulator's documented defaults. Replace them with
verbatim captures when a device is available, and record the device, emulator build
and capture command here.

The parsers accept LF or CRLF line endings, so these files are stored with LF.

| File                               | Command                                 | Format point it pins                                               |
| ---------------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| `sensor-get-acceleration.txt`      | `emu sensor get acceleration`           | Three `%g` values; the #10250 resting vector                       |
| `sensor-get-magnetic-field.txt`    | `emu sensor get magnetic-field`         | Hyphenated name; negative component                                |
| `sensor-get-orientation.txt`       | `emu sensor get orientation`            | Three values in degrees                                            |
| `sensor-get-light.txt`             | `emu sensor get light`                  | One value                                                          |
| `sensor-get-proximity.txt`         | `emu sensor get proximity`              | One value                                                          |
| `sensor-get-pressure.txt`          | `emu sensor get pressure`               | One fractional value                                               |
| `sensor-get-humidity-disabled.txt` | `emu sensor get humidity`               | `KO:` refusal for a sensor the AVD disables; no `OK` trailer       |
| `sensor-set-ok.txt`                | `emu sensor set light 500`              | A bare `OK` acknowledgement                                        |
| `sensor-set-usage-ko.txt`          | `emu sensor set acceleration 1` (arity) | `KO: Usage:` refusal the console prints for a malformed value list |
