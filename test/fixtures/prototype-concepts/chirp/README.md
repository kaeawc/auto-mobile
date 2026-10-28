# Chirp (micro-blogging concept, #14218)

An original micro-blogging concept: For you and Following timelines, posts with linkified
@mentions, #hashtags and URLs, like and repost, a poll with result bars, a 280-character composer,
a thread view, notifications and a link screen with Follow. `today.json` is the slice that runs on
today's vocabulary, with literal `data` standing in for the backend.

## Capabilities used

- `prototype_stack_v1`: home, compose, thread and link screens.
- `prototype_lazy_list_v1`: both timelines are lazy `list`s with a header and `onEndReached`.
- `prototype_data_model_v1`: timelines, poll shares, replies and notifications in `/data`.
- `prototype_data_actions_v1`: a new post is written to `/data/pending`.
- `prototype_loading_states_v1`: the new post row shows when `/data/pending` is not empty.
- `prototype_linkify_v1`: mentions, hashtags and URLs in posts, threads and replies.
- `prototype_format_v1`: poll percentages (`derive.poll0`..`poll2`).
- `prototype_text_field_options_v1`: the composer's 280-character counter, label and multiline field.
- `prototype_string_conditions_v1`: Post stays disabled while the draft is empty; poll results show after a vote.
- `prototype_checks_v1`: `enabledWhen` on Post.
- `prototype_semantics_v1`: the poll heading and the unread count's live region.
- `prototype_emit_context_v1`: `load_more`, `reposted`, `poll_voted`, `share_requested` and `post_created` carry their values.

## Test tags

`timeline_tabs`, `for_you`, `following`, `post_row`, `post_text`, `reply_count`, `repost_button`,
`like_button`, `unlike_button`, `share_button`, `my_post`, `my_post_text`, `poll_card`,
`poll_flat`, `poll_filter`, `poll_cortado`, `poll_result_flat`, `poll_result_filter`,
`poll_result_cortado`, `poll_total`, `compose_fab`, `compose_field`, `post_button`, `thread_text`,
`replies_c1`, `reply_row`, `unread_count`, `notification_row`, `link_kind`, `follow_button`,
`bottom_nav`.

## Workarounds and dead ends

| Kind       | Spec path                                        | What happens today                                                                                                    | Needs                                            |
| ---------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Workaround | `data.forYou[*].ago`, `likesText`, `repostsText` | "3m" and "1.2K" are literal row fields: `list.repeat` takes no `derive`                                               | `derive` on lazy lists (#14227)                  |
| Workaround | `for_you` `onEndReached`                         | Reaching the end emits `load_more` for the agent to answer: a literal append would repeat a row key                   | paging from the mock backend (#14181, #14271)    |
| Workaround | `like_button`, `unlike_button`                   | Liking swaps the button ("1.2K + you"); the count itself cannot grow                                                  | keyed writes (#14230)                            |
| Dead end   | `my_post`                                        | Only the latest post shows, in the timeline header: no row can be built from the draft and prepended                  | keyed writes with generated ids (#14230)         |
| Workaround | `compose_field`                                  | The 280-character limit is the field's own `maxLength` counter; there is no "characters left" value to show elsewhere | derived `length` (#14228)                        |
| Workaround | `poll_card`, `state.pollBar0`..`pollBar2`        | Poll shares and bar values are literal; a vote does not change them                                                   | derived sum (#14228)                             |
| Workaround | `replies_c1`                                     | Only `c1` has a reply section, switched by `openId`; replies do not nest                                              | `find` and nested repeat (#14229)                |
| Workaround | `unread_count`                                   | The unread count is a state key cleared by Mark all read                                                              | derived count (#14228)                           |
| Dead end   | `notification_row`                               | Notifications are an in-app list; no push opens a thread                                                              | simulated push (#14285, #14190)                  |
| Dead end   | `share_button`, `repost_button`                  | Share and repost only emit; there is no share sheet or copy link                                                      | `share.open` (#14243), clipboard on iOS (#14237) |
| Workaround | `follow_button`                                  | Follow is one `following_ana` key for every mention                                                                   | `find` (#14229)                                  |

## Simulator limits

None for this slice.
