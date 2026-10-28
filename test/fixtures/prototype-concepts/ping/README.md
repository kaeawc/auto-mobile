# Ping (messaging concept, #14224)

An original messaging concept: a chat list with unread counts and a pinned chat, conversations with
reply quotes and delivery ticks, hold-to-record voice notes, a voice call with a scripted answer,
auto-advancing status updates and a call log. `today.json` is the slice that runs on today's
vocabulary: the peer, the delivery receipts and the call are timers over literal `data`.

## Capabilities used

- `prototype_stack_v1`: home, conversation and call screens.
- `prototype_data_model_v1`: threads, messages and the call log in `/data`.
- `prototype_data_actions_v1`: a sent message is parked in `/data/pending`.
- `prototype_loading_states_v1`: the sent bubble and its quote show when `/data/pending` is not empty.
- `prototype_timers_v1`: delivery ticks, the voice-note clock, the call answer and clock, and status auto-advance.
- `prototype_gestures_v1`: long press on a message to reply, long press on the mic to record.
- `prototype_text_field_actions_v1`: the composer's send key.
- `prototype_string_conditions_v1`: the reply bar and send button follow the draft and quote length.
- `prototype_checks_v1`: `enabledWhen` on the send button, and a required check on the composer that `message_sent`'s `requireValid` uses so the keyboard's send key cannot send an empty draft.
- `prototype_pager_state_key_v1`: the status pager and its progress segments share `statusPage`.
- `prototype_semantics_v1`: headings and live regions for recording and the call state.
- `prototype_emit_context_v1`: `message_sent`, `voice_note_sent` and `call_ended` carry their values.

## Test tags

`chat_row`, `unread_badge`, `conversation_bar`, `bubble_mine`, `bubble_theirs`, `bubble_sent`,
`sent_text`, `sent_quote`, `tick_sending`, `tick_sent`, `tick_delivered`, `tick_read`, `reply_bar`,
`reply_quote`, `reply_cancel`, `composer`, `send_button`, `mic_button`, `recording_bar`,
`recording_time`, `call_ringing`, `call_connected`, `call_end`, `status_pager`,
`status_progress`, `call_row`, `bottom_nav`.

## Workarounds and dead ends

| Kind       | Spec path                                    | What happens today                                                                                                                                       | Needs                                                   |
| ---------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Workaround | `thread_ana`, `thread_bo`, `thread_climbing` | One message section per thread, switched by `chatId`, because a repeat cannot take its path from state                                                   | `find` binding (#14229)                                 |
| Workaround | `state.mine_a1`..`state.mine_c2`             | One boolean per message says whose it is: a condition cannot read a row's field                                                                          | nested repeat and `find` (#14229)                       |
| Dead end   | `bubble_sent`                                | Only the latest sent message shows, from `/data/pending`: `appendData` cannot build a `{from, text}` row from the draft and `setState` cannot copy state | optimistic keyed writes with generated ids (#14230)     |
| Workaround | `tick_sending`..`tick_read`                  | Ticks flip on fixed timers; nothing answers back                                                                                                         | scripted mock actors (#14211)                           |
| Workaround | `state.unread_ana`..`state.unread_climbing`  | Unread counts are state keys that opening a chat sets to 0                                                                                               | derived count (#14228)                                  |
| Workaround | `data.threads[*].when`                       | "Yesterday" and "09:41" are literal; rows are authored in pinned-then-recent order                                                                       | relative time from data (#14227), derived sort (#14228) |
| Workaround | `chat_row`                                   | The time sits in `supporting`: a list item's `trailing` takes only a switch, checkbox or icon                                                            | trailing text on list items                             |
| Workaround | `unread_badge`                               | A styled text stands in for `badge`, whose `text` does not bind repeat fields                                                                            | badge repeat binding                                    |
| Workaround | `mic_button`                                 | Long press starts recording and a tap sends it: a release cannot be detected, and nothing is recorded or played                                          | recording (#14194), playback (#14253)                   |
| Dead end   | `call` screen                                | The call is a timer that "answers" after 2 s; no audio or video                                                                                          | WebRTC calls (#14275), permissions (#14297)             |
| Dead end   | new chat                                     | There is no contact picker, so a chat cannot be started                                                                                                  | contacts (#14318, #14119)                               |
| Dead end   | two devices                                  | Each device has its own copy of the threads                                                                                                              | multi-device demos (#14212)                             |

## Simulator limits

The iOS simulator has no camera for video calls; the slice has no camera use today.
