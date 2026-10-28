# Huddle (team-chat concept, #14221)

An original team-chat concept: a workspace switcher in a side drawer, channels with unread and
mention markers, channel messages with linkified @mentions, #hashtags and URLs, reactions, a
thread screen, sending with a "sending" state, a teammate typing and replying, and an audio huddle
sheet. `today.json` is the slice that runs on today's vocabulary: the teammate and the huddle are
timers over literal `data`.

## Capabilities used

- `prototype_stack_v1`: home, channel, thread and link screens.
- `prototype_drawer_v1`: the workspace switcher.
- `prototype_data_model_v1`: channel messages and thread replies in `/data`.
- `prototype_data_actions_v1`: the sent text and the teammate reply are written to `/data`.
- `prototype_loading_states_v1`: the sent and reply rows show when their `/data` text is not empty.
- `prototype_linkify_v1`: mentions, hashtags and URLs in messages open the link screen.
- `prototype_timers_v1`: the send state, typing indicator, reply and huddle clock.
- `prototype_text_field_actions_v1`: the composer's send key.
- `prototype_string_conditions_v1`: the send button follows the draft length.
- `prototype_checks_v1`: `enabledWhen` on the send button.
- `prototype_semantics_v1`: headings, and live regions announcing typing and new replies.
- `prototype_emit_context_v1`: `message_sent` and `huddle_left` carry their values.

## Test tags

`workspace_drawer`, `switch_acme`, `switch_club`, `pause_notifications`, `channel_row`,
`mention_badge`, `message`, `message_text`, `reaction`, `thread_button`, `thread_root`,
`thread_reply`, `pending_message`, `pending_text`, `pending_status`, `typing_indicator`,
`teammate_reply`, `composer`, `send_button`, `huddle_sheet`, `huddle_clock`, `mute_button`,
`unmute_button`, `leave_huddle`, `link_kind`.

## Workarounds and dead ends

| Kind       | Spec path                            | What happens today                                                                                                                                                     | Needs                                                        |
| ---------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Workaround | `workspace_acme`, `workspace_club`   | One channel list per workspace, switched by `workspace`                                                                                                                | `find` binding (#14229)                                      |
| Workaround | `messages_general`..`messages_picks` | One message section per channel, switched by `channelId`                                                                                                               | `find` binding (#14229)                                      |
| Workaround | `state.unread_*`, `state.mentions_*` | Unread and mention markers are state keys that opening a channel clears                                                                                                | derived counts (#14228)                                      |
| Workaround | `reaction`                           | One 👍 button per message shows a literal count; tapping only toggles the button's highlight, since a chip label does not bind repeat fields and reactions cannot nest | nested repeat (#14229), keyed writes (#14230)                |
| Workaround | `state.hasThread_*`, `thread_reply`  | A message shows its reply button from a per-message state key, and only `m2` has a thread section                                                                      | `find` and nested repeat (#14229)                            |
| Workaround | `messages_general` "Today" header    | Day separators are literal headers                                                                                                                                     | date formatter over rows (#14227), derived grouping (#14228) |
| Dead end   | `pending_message`                    | Only the latest sent message shows: rows cannot be built from the draft                                                                                                | optimistic keyed writes (#14230)                             |
| Workaround | `typing_indicator`, `teammate_reply` | Typing and the reply are fixed timers                                                                                                                                  | realtime channels (#14261), scripted actors (#14211)         |
| Dead end   | `huddle_sheet`                       | The huddle is a clock and a mute toggle; no audio                                                                                                                      | WebRTC calls (#14275), mic permission (#14297)               |
| Dead end   | `pause_notifications`                | The switch only stores `dnd`; no push arrives to be paused                                                                                                             | simulated push (#14285, #14190)                              |
| Workaround | `link_kind`                          | A link tap opens a screen that names what was tapped; URLs never open a browser                                                                                        | —                                                            |

## Simulator limits

None for this slice: the huddle has no audio, so no microphone is needed.
