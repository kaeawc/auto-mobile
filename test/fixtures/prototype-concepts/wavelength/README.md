# Wavelength (podcast concept, #14222)

An original podcast concept: a library of shows, show pages with episode lists, a mini player and a
full player with a scrubber, skip, speed and a sleep timer, and downloads with progress.
`today.json` is the slice that runs on today's vocabulary: playback is a clock driven by timers, so
the slice plays no audio, and the catalog is literal `data`.

The slice uses mapped Material icon names so iOS can draw SF Symbols.
The library, show and player artwork use `library_music` (`music.note.list` on iOS)
for the audio collection.

## Capabilities used

- `prototype_stack_v1`: home, show and player screens.
- `prototype_data_model_v1`: shows, their episodes and the latest list in `/data`.
- `prototype_flow_grid_v1`: the two-column show grid.
- `prototype_format_v1`: "3 days ago" style relative dates from `publishedAt` (`repeat.derive.ago`).
- `prototype_timers_v1`: the playback clock, the per-speed clock rates, the sleep timer and downloads.
- `prototype_storage_v1`: the current episode and its position survive a relaunch.
- `prototype_search_bar_v1`: the library search field.
- `prototype_string_conditions_v1`: the mini player and sleep label show when their text is set.
- `prototype_checks_v1`: `enabledWhen` on finished downloads.
- `prototype_semantics_v1`: section headings.
- `prototype_emit_context_v1`: `episode_played` and `search_submitted` carry their values.

## Test tags

`show_card`, `latest_row`, `episode_row`, `search_bar`, `mini_player`, `mini_play`, `mini_pause`,
`player_title`, `scrubber`, `position_label`, `skip_back`, `skip_forward`, `player_play`,
`player_pause`, `speed_x1`, `speed_x15`, `speed_x2`, `sleep_15`, `sleep_30`, `sleep_60`,
`sleep_label`, `download_row`, `download_progress`, `download_button`, `bottom_nav`.

## Workarounds and dead ends

| Kind       | Spec path                                  | What happens today                                                                                                                                                     | Needs                                                      |
| ---------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Dead end   | `player` screen                            | No audio: "playing" is a timer that counts `positionSec`                                                                                                               | `media.play` (#14253)                                      |
| Workaround | `speed_x15`, `speed_x2`                    | Speed restarts the clock at a faster tick, and picking a speed also resumes; Play has one button per speed so resuming keeps the rate                                  | playback speed (#14249)                                    |
| Workaround | `skip_back`, `skip_forward`                | Each skip button has a second variant near the ends of the range that sets 0 or 3600, because a write outside the scrubber's range is refused and actions cannot clamp | clamped writes or conditional actions (#14216)             |
| Workaround | "End of episode" text                      | It appears only while playing at 3600, and its `onAppear` pauses, so the clock (which has no run cap) stops exactly at the end after a scrub, skip or Play there       | conditional actions or a stop condition on timers (#14216) |
| Workaround | `scrubber`                                 | The slider's `max` is a literal 3600 s for every episode, because `max` cannot bind state                                                                              | slider bound to `/platform/media/positionMs` (#14253)      |
| Workaround | `position_label`                           | Position reads "{positionSec} s of {nowMinutes} min": there is no duration formatter                                                                                   | duration formatter (#14227 follow-up)                      |
| Workaround | `show_orbit`, `show_garden`, `show_frames` | One episode section per show, switched by `showId`, because a repeat cannot take its path from state                                                                   | `find` binding (#14229)                                    |
| Dead end   | `search_bar`                               | Search only emits `search_submitted`; nothing filters                                                                                                                  | derived filter (#14228)                                    |
| Workaround | `download_button`                          | Downloads share one `download` timer (timer ids cannot bind a row), so starting a second download stops the first                                                      | downloads (#14252), background work (#14301)               |
| Dead end   | lock screen                                | No media session or notification controls, and the clock stops in the background                                                                                       | media session (#14250, #14251), background work (#14301)   |
| Dead end   | cast                                       | There is no cast button or route                                                                                                                                       | `castButton` (#14239, #14241)                              |

## Simulator limits

None for this slice: it plays no audio and uses no cast route.
