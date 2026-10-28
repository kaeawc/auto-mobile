# Hop (ride-hailing concept, #14220)

An original ride-hailing concept: pick a saved place from a "Where to?" sheet, compare ride options
with USD fares and ETAs, choose how to pay, request a ride, follow matching, the driver's approach
and the trip, then rate the driver and tip. `today.json` is the slice that runs on today's
vocabulary: the map is a placeholder and the driver is a chain of timers.

## Capabilities used

- `prototype_stack_v1`: home, options and trip screens; the trip replaces the options screen.
- `prototype_data_model_v1`: saved places and ride options in `/data`.
- `prototype_format_v1`: USD fares on ride options (`repeat.derive.priceText`) and on the trip (`derive.fareText`).
- `prototype_timers_v1`: matching, the ETA countdown and route progress, pickup and drop-off.
- `prototype_menus_v1`: the payment `select`.
- `prototype_string_conditions_v1`: Request stays disabled until a ride is picked.
- `prototype_checks_v1`: `enabledWhen` on Request and Done.
- `prototype_semantics_v1`: the rating heading and live regions announcing each trip stage.
- `prototype_emit_context_v1`: `ride_requested` and `trip_rated` carry their values.

## Test tags

`map`, `where_to`, `places_sheet`, `place_row`, `ride_option`, `surge_note`, `payment_select`,
`request_ride`, `stage_matching`, `stage_arriving`, `stage_onTrip`, `stage_done`,
`route_progress`, `driver_card`, `fare`, `cancel_ride`, `rating_panel`, `star_row`,
`star_1`..`star_5`, `tip_picker`, `submit_rating`.

## Workarounds and dead ends

| Kind       | Spec path              | What happens today                                                                                                                  | Needs                                                                                     |
| ---------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Dead end   | `map`                  | The map is a labelled box: no map, markers, route polyline or current location                                                      | `map` (#14309), location (#14324)                                                         |
| Workaround | `request_ride` timers  | Matching, the ETA countdown, pickup and drop-off are nested timers (2 s, then 1 s ticks, 5 s, 9 s)                                  | scripted actors with `advance` (#14211), realtime (#14261)                                |
| Workaround | `request_ride`         | A request first cancels the last trip's timers and clears the picked ride, because system Back leaves a trip without running Cancel | `routes.onBack` (`prototype_routes_v1`, unadvertised)                                     |
| Workaround | `route_progress`       | The driver's approach is a progress bar that grows 25% a tick                                                                       | map polyline and a moving marker (#14309)                                                 |
| Workaround | `surge_note`           | Surge is a literal note and fares are literal                                                                                       | mock backend fares (#14271)                                                               |
| Workaround | `ride_option`          | The picked ride is highlighted with `styleWhen` on `rideId`; a radio group cannot show a formatted fare per option                  | —                                                                                         |
| Dead end   | `payment_select`       | Paying only records the choice; there is no wallet sheet                                                                            | fake store (#14314), wallet sandboxes (#14315)                                            |
| Dead end   | trip in the background | Timers pause when the app is hidden; no status notification or Live Activity                                                        | background work (#14301), `notifications.post` (#14280), Live Activities (#14306, #14279) |
| Workaround | `star_row`             | Stars are five icon buttons coloured with `styleWhen` on `rating`                                                                   | —                                                                                         |
| Dead end   | driver app             | Only the rider side exists                                                                                                          | multi-device demos (#14212)                                                               |

## Simulator limits

None for this slice: it reads no location. Once #14324 lands, the plan sets the location with
`setDeviceState` on both platforms.
