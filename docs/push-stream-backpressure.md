# Push stream backpressure

Push sockets use newline-delimited JSON. Healthy readers receive each existing
message immediately, in its original JSON format. A `write()` returning false
pauses further writes on that connection until `drain`.

While paused, `screenshot_update` and `hierarchy_update` retain only the latest
message per subscription, deviceId, deviceSessionUuid and type. Absent, null and
string session UUIDs are distinct epochs. Hierarchies carry the full tree; their diff
annotations are advisory. There is no separate `observation_update` wire type.
Replacements keep their slot's original position in the connection FIFO, ahead
of any later acknowledgements. All-device subscriptions retain separate slots
for each deviceId, deviceSessionUuid and type. Frames from a new epoch queue after
the preceding epoch's pending frames and intervening lifecycle events.
A recovering client must continue pairing screenshot and hierarchy by
`captureSequence`; coalescing does not establish that they describe the same capture.

Every other type remains FIFO, including ping/pong, errors, subscription replies,
lifecycle/build context, navigation, storage, performance, telemetry and failure
events, unknown future types, and replies carrying `id` or `requestId` even if
named like state updates. These may represent transitions, deltas or correlated
requests. Unsubscribing removes retained state for that subscription, while
queued control messages and the unsubscribe acknowledgement retain their order.

If `socket.writableLength` exceeds 8 MiB, uncorrelated screenshot frames are
replaced by a small additive notification:

```json
{
  "type": "frames_dropped",
  "subscriptionId": "observationstream-1",
  "deviceId": "emulator-5554",
  "deviceSessionUuid": "device-session-1",
  "droppedType": "screenshot_update",
  "reason": "backpressure"
}
```

At most one notification per subscription, deviceId and deviceSessionUuid is
generated until a drain attempt or a send observes the buffer back at or below
the threshold. It preserves
the dropped frame's deviceId and deviceSessionUuid (including null, or omission
when absent), shares the control FIFO and carries no screenshot bytes. Existing observation
clients decode the type as a string, tolerate unknown fields and log/ignore
unknown types, so this notification does not require a client upgrade. It does
not claim a precise drop count or invalidate capture provenance.

The 8 MiB threshold is not a maximum frame size: an individual screenshot may
exceed it, and the first frame is admitted unchanged. While stalled the socket
accepts no additional writes; outside it, there is at most one pending state
frame per subscription/deviceId/deviceSessionUuid/type plus lossless controls.
Coalesced types retain at most one frame per slot; memory across epochs and for
non-coalesced frames is bounded by the liveness timeout and producer rate.
Keepalive pings and timeout reaping remain active; only inbound pong or drain progress
refreshes liveness, never a successful local write.
Sockets with no subscription still receive keepalive while a stalled reply is queued.

Serialization remains per delivered message. The abstract `createPushMessage`
hook may produce subscriber-specific fields and per-call timestamps, so generic
payload splicing cannot guarantee byte-identical output. Deferred state frames
are serialized only if they survive coalescing.
