# Neighborly (community concept, #14219)

An original neighbourhood community concept: a news feed of text, photo, link and video posts with
a long-press reaction menu, a shortcuts drawer listing groups, group pages with join and leave, a
marketplace grid with a price filter and an item page, and a messenger thread with a typing
neighbour. `today.json` is the slice that runs on today's vocabulary, with literal `data` and timers
standing in for the backend and the other person.

## Capabilities used

- `prototype_stack_v1`: home, group, listing and hashtag screens.
- `prototype_data_model_v1`: posts, groups and listings in `/data`.
- `prototype_flow_grid_v1`: the two-column marketplace grid.
- `prototype_format_v1`: USD prices on listings and the item page.
- `prototype_gestures_v1`: long press on a post opens its reaction menu.
- `prototype_menus_v1`: the reaction menu.
- `prototype_drawer_v1`: the shortcuts drawer.
- `prototype_linkify_v1`: hashtags in posts and the link card's URL.
- `prototype_refresh_v1`: pull to refresh on the feed.
- `prototype_data_actions_v1`: the sent message and the reply are written to `/data`.
- `prototype_loading_states_v1`: the sent and reply rows show when their `/data` text is not empty.
- `prototype_timers_v1`: the typing indicator and reply.
- `prototype_text_field_actions_v1`: the composer's send key.
- `prototype_string_conditions_v1`: the reaction line and send button follow text length.
- `prototype_checks_v1`: `enabledWhen` on the send button.
- `prototype_semantics_v1`: headings and live regions for typing and the reply.
- `prototype_emit_context_v1`: `group_joined`, `group_left`, `link_opened` and `message_sent` carry their values.

## Test tags

`feed_scroll`, `post_card`, `post_body`, `post_photo`, `post_video`, `post_link`, `post_reaction`,
`reaction_menu`, `shortcuts_drawer`, `group_row`, `group_members`, `join_group`, `leave_group`,
`price_filter`, `listing_card`, `listing_map`, `listing_price`, `message_seller`, `thread_row`,
`pending_message`, `pending_text`, `typing_indicator`, `reply_message`, `composer`, `send_button`,
`bottom_nav`.

## Workarounds and dead ends

| Kind       | Spec path                             | What happens today                                                                                                                                                         | Needs                                       |
| ---------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Workaround | `state.kind_text`..`state.kind_video` | Post types switch with `{key: "kind_{post.kind}", equals: "photo"}`: each `kind_<k>` key holds its own name, because a condition cannot compare a row field with a literal | conditions on row fields                    |
| Workaround | `post_photo`, `listing_card`          | Photos are tinted boxes: the slice ships no image assets                                                                                                                   | remote images (#14181)                      |
| Dead end   | `post_video`                          | A video post is a still frame with a play icon                                                                                                                             | `videoPlayer` (#14253)                      |
| Workaround | `state.react_*`, `state.reaction_*`   | One open key and one reaction key per post                                                                                                                                 | keyed writes (#14230)                       |
| Workaround | `listing_card` `visibleWhen`          | The price filter matches a precomputed `band` field; there is no distance filter or sort                                                                                   | derived filter and sort (#14228)            |
| Dead end   | `group` screen                        | A group page shows its name and member count but no posts: the feed cannot be filtered by group                                                                            | `find` (#14229), derived filter (#14228)    |
| Workaround | `join_group`, `leave_group`           | Join and leave are per-group button pairs switched by `groupId` and `joined_<id>`; nothing can fail and roll back                                                          | optimistic keyed writes (#14230)            |
| Dead end   | `listing_map`                         | The item page shows a placeholder map                                                                                                                                      | `map` (#14309)                              |
| Dead end   | `pending_message`                     | Only the latest sent message shows: rows cannot be built from the draft                                                                                                    | optimistic keyed writes (#14230)            |
| Workaround | `typing_indicator`, `reply_message`   | The neighbour types and answers on fixed timers                                                                                                                            | realtime (#14261), scripted actors (#14211) |

## Simulator limits

None for this slice: it plays no video and reads no location.
