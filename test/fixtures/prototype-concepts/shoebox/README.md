# Shoebox (gallery concept, #14226)

An original photo-gallery concept: a day-grouped photo grid, a select mode, albums, a photo viewer
and a backup screen. `today.json` is the slice that runs on today's vocabulary, with literal `data`
standing in for the device media library and the mock backend. Tiles are drawn as icon placeholders,
since the slice ships no image assets.

The slice uses mapped Material icon names so iOS can draw SF Symbols.
Backup uses `file_upload` (`arrow.up.to.line` on iOS); the denied-photo state uses
`block` (`nosign`) to indicate no access.

## Capabilities used

- `prototype_stack_v1`: home and viewer screens.
- `prototype_data_model_v1`: day groups and albums in `/data`, read by `repeat` and `{data:...}`.
- `prototype_flow_grid_v1`: three-column photo grid and two-column album grid.
- `prototype_format_v1`: the viewer's "taken" date (`derive.takenText`).
- `prototype_refresh_v1`: pull to refresh on the photo scroll.
- `prototype_timers_v1`: the backup progress ticks.
- `prototype_semantics_v1`: day headings, the selected trait and the backup live region.
- `prototype_emit_context_v1`: `share_requested`, `album_opened` and `added_to_album` carry ids.

## Test tags

`photo_tile` (opens the viewer), `photo_select` / `photo_selected` (select mode), `select_bar`,
`limited_banner`, `allow_all_button`, `denied_state`, `album_card`, `album_sheet`, `album_choice`,
`viewer_bar`, `viewer_taken`, `backup_start`, `backup_pause`, `backup_progress`, `backup_done`,
`access_picker`, `bottom_nav`.

## Workarounds and dead ends

| Kind       | Spec path                                                              | What happens today                                                                                                                                                    | Needs                                            |
| ---------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Workaround | `root.screens.home.children[0].children[0].children[4].child.children` | One hand-written section per day, each repeating `/days/<n>/photos`, because a repeat cannot nest inside another                                                      | nested repeat (#14229)                           |
| Workaround | `data.days[*].label`                                                   | Day headers ("Mon, Oct 12") are literal strings; the date formatter has no weekday-and-day style                                                                      | formatter styles (#14227 follow-up)              |
| Workaround | `state.sel_p1`..`state.sel_p9`                                         | One boolean per photo for selection, and `selectedCount` kept by `increment` / `decrement` on the tile variants                                                       | derived count (#14228)                           |
| Workaround | `photo_tile`, `photo_select`, `photo_selected`                         | Three tile variants switched by `visibleWhen`, since one tap list cannot branch on select mode                                                                        | conditional actions (#14216)                     |
| Workaround | `state.access`, `access_picker`                                        | Library permission (full, limited, denied) is a state key set from the Backup tab                                                                                     | media library access (#14195, #14297)            |
| Dead end   | `viewer` screen                                                        | The viewer shows only the tapped photo: a `pager` cannot `repeat` over `/data`, so there is no swipe between photos, and with no image asset there is nothing to zoom | data-driven pager, image assets (#14208, #14192) |
| Dead end   | `album_choice`                                                         | Adding to an album only emits `added_to_album`; the album count does not change                                                                                       | keyed writes (#14230)                            |
| Dead end   | `viewer_bar` share action                                              | Share only emits `share_requested`; casting is absent                                                                                                                 | `share.open` (#14243), casting (#14239)          |
| Dead end   | `backup_start`                                                         | Backup is a timer that counts to 100%; there is no upload or background work                                                                                          | uploads (#14272), background work (#14301)       |
| Dead end   | `album_card`                                                           | Opening an album only emits `album_opened`: no screen can list an album's photos without filtering                                                                    | derived collections (#14228)                     |

## Simulator limits

None for this slice: it uses no camera, Bluetooth or photo library access.
