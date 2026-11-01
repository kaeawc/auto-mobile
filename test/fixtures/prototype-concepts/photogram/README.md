# Photogram (photo-sharing concept, #14217)

An original photo-sharing concept: a feed of photo carousels with double-tap likes and a heart
burst, compact like counts and linkified captions, a story tray opening auto-advancing stories,
vertical reels, a profile grid with a photo viewer, direct messages and a new-post screen.
`today.json` is the slice that runs on today's vocabulary: photos and videos are tinted
placeholders and everything is literal `data`.

The slice uses mapped Material icon names so iOS can draw SF Symbols.
The Reels tab uses `local_movies` (`film` on iOS) for video content.

## Capabilities used

- `prototype_stack_v1`: home, stories, viewer, inbox, conversation, new-post and link screens.
- `prototype_data_model_v1`: stories, the profile grid, DM threads and counts in `/data`.
- `prototype_carousel_v1`: multi-photo posts.
- `prototype_gestures_v1`: double tap on a photo likes it.
- `prototype_keyframes_v1`: the heart bursts on each double tap.
- `prototype_format_v1`: compact like and follower counts ("1.3K").
- `prototype_linkify_v1`: mentions and hashtags in captions.
- `prototype_refresh_v1`: pull to refresh on the feed.
- `prototype_timers_v1`: stories advance every 5 s.
- `prototype_pager_state_key_v1`: the story pager and its progress segments share `storyPage`.
- `prototype_pager_options_v1`: reels are a vertical pager.
- `prototype_flow_grid_v1`: the three-column profile grid.
- `prototype_data_actions_v1`: a sent DM is written to `/data/pending`.
- `prototype_loading_states_v1`: the sent DM shows when `/data/pending` is not empty.
- `prototype_text_field_actions_v1`: the DM composer's send key.
- `prototype_text_field_options_v1`: the caption field's label, lines and 2,200-character counter.
- `prototype_string_conditions_v1`: the DM send button follows the draft length.
- `prototype_checks_v1`: `enabledWhen` on the DM send button, and a required check on the DM composer that `dm_sent`'s `requireValid` uses so the keyboard's send key cannot send an empty draft.
- `prototype_semantics_v1`: story headings.
- `prototype_emit_context_v1`: `comments_opened`, `share_requested`, `dm_sent` and `post_shared` carry their values.

## Test tags

`story_tray`, `story_ring`, `story_progress`, `story_pager`, `close_story`, `post_p1`..`post_p3`,
`post_media`, `post_carousel`, `post_slide`, `heart_burst`, `like_button`, `unlike_button`,
`comments_button`, `share_button`, `like_count`, `caption`, `reels_pager`, `mute_toggle`,
`grid_photo`, `viewer_photo`, `dm_row`, `dm_sent`, `dm_composer`, `dm_send`, `upload_preview`,
`caption_field`, `share_post`, `bottom_nav`.

## Workarounds and dead ends

| Kind       | Spec path                      | What happens today                                                                                  | Needs                                                              |
| ---------- | ------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Workaround | `post_p1`..`post_p3`           | One hand-written card per post: a repeated post cannot repeat over its own photos inside a carousel | nested repeat (#14229)                                             |
| Workaround | `post_slide`, `grid_photo`     | Photos are tinted boxes: the slice ships no image assets                                            | remote images (#14181)                                             |
| Workaround | `like_count`                   | Like counts are compact-formatted data that a like does not change; the heart swaps instead         | keyed writes with rollback (#14230)                                |
| Dead end   | `like_button`                  | No server round trip, so there is no seeded fault to roll back                                      | optimistic mutations (#14230), mock faults (#14271)                |
| Workaround | `story_ring`                   | Stories advance on a 5 s timer bound to the pager's `storyPage`; there is no video story            | `videoPlayer` (#14253)                                             |
| Dead end   | `reels_pager`                  | Reels are still frames; nothing autoplays and the mute toggle only flips `muted`                    | autoplay in feed (#14258)                                          |
| Dead end   | `viewer_photo`                 | The viewer cannot zoom a placeholder                                                                | zoomable image assets (#14208)                                     |
| Dead end   | `dm_sent`                      | Only the latest DM shows, and every thread shares it                                                | chat lists on iOS (#14232), keyed writes (#14230), `find` (#14229) |
| Dead end   | `upload_preview`, `share_post` | No photo can be picked or captured, and Share only emits `post_shared`                              | media pick and capture (#14197), uploads (#14272)                  |
| Dead end   | like notification              | No push opens the post                                                                              | simulated push (#14280, #14285)                                    |

## Simulator limits

The iOS simulator has no camera. Today the slice uses neither camera nor photo library; once
#14197 lands, the plan seeds the library with `simctl addmedia` and simulates capture.
