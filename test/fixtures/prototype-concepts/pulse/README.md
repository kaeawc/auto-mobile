# Pulse (wearable companion concept, #14225)

An original fitness-band companion: pair a band, follow a live workout with heart-rate zones, and
read step, resting heart rate and sleep history. `today.json` is the slice that runs on today's
vocabulary: the band scan, the heart-rate stream and the health history are literal `data` and
timers standing in for Bluetooth and the health store.

## Capabilities used

- `prototype_stack_v1`: pair, home and band settings screens; unpairing pops to the pair screen.
- `prototype_timers_v1`: the scan delay, the workout clock and the heart-rate ramp.
- `prototype_chart_v1`: the step ring, resting heart rate line, last-run area and history bars.
- `prototype_data_model_v1`: bands, splits and chart series in `/data`.
- `prototype_format_v1`: today's step count with grouping (`derive.stepsText`).
- `prototype_content_transition_v1`: the heart-rate number rolls as it changes.
- `prototype_checks_v1`: `enabledWhen` on the scan and workout buttons.
- `prototype_semantics_v1`: section headings and live regions for the scan and the zone.
- `prototype_emit_context_v1`: `band_paired` and `workout_saved` carry their values.

## Test tags

`scan_button`, `scan_progress`, `band_results`, `band_result`, `band_status`, `steps_ring`,
`steps_label`, `hr_value`, `hr_zone`, `elapsed`, `workout_start`, `workout_pause`,
`workout_finish`, `hr_chart`, `split_row`, `range_picker`, `steps_week`, `steps_month`,
`sleep_week`, `band_battery`, `band_vibrate`, `unpair_button`, `bottom_nav`.

## Workarounds and dead ends

| Kind       | Spec path                               | What happens today                                                                                                                 | Needs                                                        |
| ---------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Workaround | `scan_button`                           | Scanning is a 1.5 s timer that reveals the literal `/bands` list                                                                   | BLE scan and connect (#14266), Bluetooth permission (#14297) |
| Workaround | `workout_start` timer `heart`           | Heart rate is a counter that climbs 1 bpm a second for 90 s, so it crosses the zones                                               | BLE notify into `/data` (#14266)                             |
| Dead end   | `hr_chart`                              | The workout chart shows a recorded run: `appendData` cannot build a `{t, bpm}` row from state, so the live value cannot be charted | BLE notify into `/data` (#14266), keyed writes (#14230)      |
| Workaround | `hr_zone`                               | Zones are three texts with `lt` / `gt` conditions on `bpm`; nothing buzzes when the zone changes                                   | haptics (#14329)                                             |
| Workaround | `elapsed`                               | Elapsed time reads "{seconds} s": there is no duration formatter                                                                   | duration formatter (#14227 follow-up)                        |
| Workaround | `data.splits[*].pace`                   | Pace strings such as "5:12 /km" are literal                                                                                        | formatters (#14227), location (#14324)                       |
| Dead end   | `background_note`                       | Recording stops when the app leaves the foreground; no ongoing notification                                                        | background work (#14301), `notifications.post` (#14280)      |
| Workaround | `data.week`, `data.month`, `data.sleep` | History charts read literal series                                                                                                 | health data (#14215)                                         |
| Dead end   | `steps_ring`                            | The goal ring lives only in the app                                                                                                | widgets (#14306)                                             |

## Simulator limits

The iOS simulator has no Bluetooth. Today the slice uses no Bluetooth at all; once #14266 lands,
the plan uses the simulation path for the band.
