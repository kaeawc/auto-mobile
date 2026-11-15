# Prototype spec: media players, camera, casting and haptics

Part of [the agent-authored prototype specification](prototype-ux.md).

**Media players (#14253, contract only).** The root `media` block declares long-lived players
that outlive a screen (mini-player, background audio, picture-in-picture):

```json
{
  "requires": { "platform": ["media"] },
  "media": {
    "players": {
      "main": { "kind": "video", "source": { "asset": "trailer" }, "loop": false },
      "podcast": { "kind": "audio", "source": { "sample": "tone440" } }
    }
  }
}
```

- At most `MAX_PROTOTYPE_MEDIA_PLAYERS` (4) players; each id is a state key. `kind` is `video` or
  `audio`; `loop` is optional.
- `source` is exactly one of `{asset: id}` (an uploaded media asset or a device `media:` id),
  `{url}` (an absolute `http` or `https` URL, the `mediaUrl` pattern), `{data: "/pointer"}` (resolved
  at runtime) or `{sample}`. For `{sample}`, `tone440` and `silence` are synthesized audio, `colorBars` and
  `countdown` are generated video.
- The block needs `media` in `requires.platform`, so `prototype_platform_media_v1` gates it.

The `media` module (`prototype_platform_media_v1`) has the calls `play`, `pause`, `toggle`, `stop`,
`seek` (`positionMs`, 0-86400000) and `seekBy` (`deltaMs`, ±86400000). It also has `setRate` (`rate`, 0.25-4),
`setVolume` (`volume`, 0-1, the player's own volume, never the device stream), `setMuted` and
`setLoop`. Every call takes a `player` argument; a literal `{value}` must name a declared player.
Its events are `media.statusChanged`, `media.ended` and `media.error`. State is per player at
`/platform/media/players/<id>/<key>`: `playing`, `positionMs`, `durationMs` (`-1` while unknown),
`buffering`, `status` (`idle`, `loading`, `ready`, `ended`, `error`) and `error`
(`source_not_found`, `decode`, `network`, `unsupported_format`, `blocked_egress`). A read must name
a declared player and one of those keys. The asset transport and the renderers are separate
slices; no production runtime advertises the module yet.

The `videoPlayer` node renders exactly one of a declared `player` or an inline `source` (the same
one-key union), which is a node-scoped player released when the node leaves composition:

```json
{ "type": "videoPlayer", "player": "main", "autoplay": "whenVisible", "muted": true }
```

- An inline player is addressed by the node `id`, which must be a state key that no declared
  player uses; `media.*` calls and `/platform/media/players/<id>` reads accept it like a declared
  id.
- Optional fields: `poster` (an image asset id), `controls` (`builtin` or `none`), `contentScale`
  (`fit`, `crop`, `fill`), `autoplay` (`true`, `false` or `"whenVisible"`), `muted`, `loop`,
  `startMs` (0-86400000) and `positionKey`. The `positionKey` field is a declared number state key the device mirrors the
  position into. A slider bound to it holds device writes while it is dragged and seeks on release.
- Every `videoPlayer` needs `media` in `requires.platform`. Authored controls are ordinary nodes
  calling `media.*`.
- At most `MAX_PROTOTYPE_VIDEO_NODES` (64) `videoPlayer` nodes, counted in the authored tree and
  again after repeat expansion, so every repeat instance counts. A `poster` costs one image against
  `MAX_PROTOTYPE_IMAGES` in both counts.

**Captions (#14259, contract only).** A `videoPlayer` may list up to 8 `captions` tracks
`{id, language, label, source}`, where `source` is an uploaded WebVTT `{asset}` or `{data}`, a `/data`
pointer to an array of `{startMs, endMs, text}` cues that each end after they start. Track ids are
unique per player; `hls:` ids are reserved for in-band HLS tracks. `media.setCaptions` (`player`,
`track`, `""` for off) selects a track and `/platform/media/players/<id>/captionTrack` reports it.
The cue parser and caption overlay are separate slices.

**Feed autoplay.** A `videoPlayer` with
`autoplay: "whenVisible"` may set `visibleThreshold` (0.1-1, default 0.6) and `resumePosition`;
either field without `"whenVisible"` is an error. Feed players share at most
`MAX_PROTOTYPE_ACTIVE_DECODERS` (3) decoders, allocated by a pure function that Kotlin and Swift
both replay against `test/fixtures/prototype-media-pool`:

- The anchor is the settled pager page, or else the most visible player, with ties going to the
  topmost.
- The window is the anchor, the next item and the previous item, in that order.
- The anchor plays only in the foreground, and only when its page has settled or, in a list, when
  it is at least `visibleThreshold` visible.
- Other window players preload; held players outside the window are released.
- When nothing is visible, every player is released.

The allocator only decides which players play, preload or release. Each renderer reports visible
fractions, the settled page and foreground state, binds pooled players to surfaces and preloads.

**Queues (#14249, contract only).** A declared player takes exactly one of `source` or `queue`, a
`/data` pointer to an array of `{id, title, artist?, album?, artwork?, source, durationMs?}` items
with unique ids; `appendData` and `removeData` edit the queue at runtime. A queued player, and the
calls `media.next`, `previous` (restarts after 3 s), `skipTo` (`itemId`), `setShuffle`,
`setRepeat` (`off`, `one`, `all`) and `setSleepTimer` (`timer` `{ms}`, 0 cancels, or
`{endOfItem: true}`), need `prototype_platform_media_queue_v1`. Per-player state adds
`currentItemId`, `currentIndex`, `rate`, `sleepRemainingMs`, `shuffle` and `repeat`, and
`media.itemChanged` reports an item change. No runtime advertises the capability yet.

Queue semantics are a pure state machine (`PrototypeQueue`) that Kotlin and Swift both replay against
`test/fixtures/prototype-media-queue`; the host only validates. Renderers report `ended`, the
playhead, clock ticks and queue edits, and map the state onto their engine:

- The play order is the queue order, or a Fisher-Yates shuffle driven by an injected `Random` that
  keeps the current item first. Turning shuffle off restores queue order.
- `next` ignores repeat `one`; an item ending replays under it. Past the last item, repeat `all`
  wraps and `off` stops on that item. `previous` restarts after 3 s, and at the first item wraps
  under `all` or otherwise restarts.
- A `{ms}` sleep timer counts down on the renderer's clock and pauses at zero; `{endOfItem}` pauses
  when the current item ends instead of advancing.
- When a data action edits the queue, play order keeps its relative order and appends new items.
  Removing the current item moves to the next surviving one, or with none left wraps under `all`
  or stops on the last item. `skipTo` an unknown id fails with `item_not_found`.

**Fake media engine and simulate (#14257).** `PrototypeFakeMediaEngine` (TypeScript, Kotlin in
`android/protocol`, Swift in the prototype agent core) is a deterministic player that decodes
nothing. All three replay the event scripts and expected `/platform/media` state in
`test/fixtures/prototype-media-sim`:

- Time is virtual and moves only when the runtime's injected clock calls `advance`. A playing,
  ready, non-buffering player advances, then ends at `durationMs`, or wraps when it loops. A
  `durationMs` of `-1` never ends.
- `media.statusChanged` and `media.error` are reported only on a status or `playing` change, and
  `media.ended` and `media.error` once per transition. `buffering` stalls the playhead without an
  event.
- An errored player ignores `play` and `seek` until an event sets it `ready`. Seeking back from
  `ended` returns to `ready`.

The host delivers an event with `prototype {action: "simulate", id, event, data}`. The `event` is
`media.statusChanged` (`data` `{player, status, code?}` with `status` `buffering`, `ready`, `ended`
or `error`), `media.ended` (`{player}`) or `media.error` (`{player, code}`). `code` is one of the
state's error codes and is required exactly when the status is `error`. An optional `advanceMs`
(1-3600000) advances the fake engine's clock first. The host validates `data` before it asks the
device (`invalid_args`). It refuses `advanceMs` on a native engine (`unsupported`) and reports the
engine as `mediaEngine`. No runtime exposes its media module to simulate yet, so every device
answers `unavailable`. Selecting the fake engine (`platformMode`) and the `Media3` adapter belong to
the platform simulation runtime (#14300).

The fake engine proves spec logic, not playback. Real playback is confirmed separately. On Android
the `mediaSession` tool reads the session's playback state and position (#14117), and `captureAudio`
checks that the output is not silent on hosts where emulator or Simulator audio capture works
(#13629). Generated test clips come from `scripts/media/generate-prototype-test-media.sh`.

**Live camera (#14202, calls only).** The `camera` module also drives an in-app viewfinder:
`camera.takePhoto` writes an image item to `into`, `camera.startRecording` (optional `audio` boolean and
`maxDurationMs` 1-600000) and `camera.stopRecording` (writes a video item to `into`). Each takes
`preview`, the id of the viewfinder it acts on, needs `camera` in `requires.permissions` and is
`sensitive`. Recording also needs `prototype_platform_camera_video_v1`. The `camera.statusChanged` event and the
`/platform/camera/status` state report `starting`, `ready`, `capturing`, `recording`, `unavailable`,
`permission_denied` or `error`; `/platform/camera/flashAvailable`, `recordingMs` and `source`
(`camera` or `injected`, the fake frame source on a Simulator) complete the state.

The `cameraPreview` node is that viewfinder; a story-capture screen pairs it with ordinary buttons:

```json
{
  "type": "cameraPreview",
  "lensKey": "lens",
  "flashKey": "flash",
  "zoomKey": "zoom",
  "aspectRatio": "4:3",
  "contentScale": "crop",
  "tapToFocus": true,
  "pinchToZoom": true,
  "mode": "photo"
}
```

- A spec has at most one `cameraPreview`. It needs an `id` that is a state key, which `camera.*`
  calls name as their literal `preview` (`platform-camera-live.json` is the full story-capture spec).
- It needs `camera` in `requires.platform` and in `requires.permissions`.
- `lensKey` and `flashKey` name declared string state keys (`back` or `front`; `off`, `on`, `auto`
  or `torch`) and `zoomKey` a declared number key (0-1), so `setState` and a slider drive them.
- Optional: `aspectRatio` (`4:3`, `16:9`, `1:1`), `contentScale` (`fit`, `crop`, `fill`),
  `tapToFocus`, `pinchToZoom` and `mode` (`photo` or `video`). No renderer draws it yet.

**Casting (#14239, module only).** The `cast` module (`prototype_platform_cast_v1`) covers Google
Cast on Android and AirPlay on iOS with one vocabulary. Its calls are the remote-only controls:
`cast.disconnect` (end the session and resume locally), `cast.stop` (end it and stop the receiver
app) and `cast.setVolume` (`volume` 0-1, the remote device volume). Play, pause and seek stay on the
`media.*` calls. A platform that cannot do an op (AirPlay `disconnect` or `setVolume`) fails with
`unsupported`. Event data is a closed object (unknown keys are refused):

| event             | data                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `routesChanged`   | `state` (as `/platform/cast/state`), `routeCount` (integer >= 0)                                                   |
| `sessionStarting` | `player` (1-64 chars), `protocol`, `deviceName` (0-256 chars)                                                      |
| `sessionStarted`  | as `sessionStarting`, plus `positionMs` (integer >= 0, the remote position)                                        |
| `sessionEnded`    | as `sessionStarted`; `positionMs` is where local playback resumes                                                  |
| `sessionFailed`   | `player`, `reason` (`media_not_castable`, `play_services_unavailable`, `network`, `receiver`), optional `protocol` |
| `remoteVolume`    | `volume` (0-1)                                                                                                     |

The host decodes them with `prototypeCastEventOf` (truncated data does not decode). Kotlin
`PrototypeCastEvents` and Swift `PrototypeCastEvents` are the twins, and all three replay
`test/fixtures/prototype-spec/cast/events.json`. The `/platform/cast/state` value is `unavailable`, `noDevices`, `notConnected`,
`connecting` or `connected`. It carries `deviceName`, `protocol` (`googleCast` or `airplay`), `protocols`
(the unique protocols the device supports, read whole as `{platform:/cast/protocols}`; an iOS agent
reports `["airplay"]`), `player` (the cast `media` player id) and `volume`. CtrlProxy never advertises
the module.

The `castButton` node is the system route picker that starts a session; there is no start call. Its
required `player` names a declared `media.players` id or an inline `videoPlayer` id, and optional
`protocols` (1-2 unique of `googleCast`, `airplay`) limits the routes it offers. Every `castButton`
needs `cast` in `requires.platform`. No renderer draws it yet.

**Haptics and sound (#14329).** The `haptics` module has one call,
`haptics.perform` with `effect` one of `click`, `tick`, `heavyClick`, `doubleClick`, `selection`,
`success`, `warning`, `error`, `impactLight`, `impactMedium`, `impactHeavy` or `longPress`
(capability `prototype_platform_haptics_v1`). The `sound` module has `sound.play` with `sound`
one of `click`, `send`, `receive` or `shutter` and an optional `volume`, a whole number 0-100
(`prototype_platform_sound_v1`). Both lists are closed: a literal `{asset: ...}` sound is refused
(there is no audio asset type, #14254). Neither module has events or `/platform` state, needs a
runtime permission (`VIBRATE` is a normal permission, declared by CtrlProxy) or touches personal
data. CtrlProxy and the iOS prototype agent register both modules and advertise the capabilities;
the embedded Compose renderer leaves modules to the app.

- **Android haptics** use the `Vibrator`. From API 29 they use `VibrationEffect.createPredefined` (click and
  impactMedium click; tick, selection and impactLight tick; heavyClick, impactHeavy, longPress and
  warning heavy click; doubleClick and success double click), and `error` is a two-pulse waveform. Below
  API 29 they use a tuned one-shot or waveform. There is no tapped `View` to call
  `performHapticFeedback(CONFIRM/REJECT)` on, so success, warning and error use these fallbacks.
  The renderer reports touch feedback off in system settings, or a device without a vibrator
  (`suppressed` / `unavailable`). The `shutter` cue is `MediaActionSound`, `click` is the system
  click sound effect, and `send` / `receive` are short system tones. The renderer bundles no audio, and the
  ringer (silent or vibrate) and the touch-sounds setting suppress them.
- **iOS haptics** use `UIImpactFeedbackGenerator`, `UISelectionFeedbackGenerator` and
  `UINotificationFeedbackGenerator` (doubleClick is two impacts 80 ms apart). The Simulator does
  not render haptics, but the call still succeeds and the agent logs it. "System Haptics" off and the silent
  switch are not detectable, so the agent reports nothing as suppressed. Sounds are `AudioServices` system
  sounds (click 1104, send 1001, receive 1007, shutter 1108); the agent ignores `volume` and never
  touches the host's `AVAudioSession`.
- **`feedbackLog`.** Each shown prototype keeps its last 64 calls, oldest first, and `prototype
  inspect` (and `status`) returns them as `feedbackLog: [{effect | sound, nodeId?, timeMs,
  suppressed?}]`. The `nodeId` field is the one node whose tap, long-press or double-tap action made the
  call, absent for a platform handler or when several nodes author the same call. The `timeMs` field is the
  device clock. The log skips failed calls; a show or dismissal clears the log.

| Field                  | Rule                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `call`                 | Required: `"<module>.<op>"` naming a call in `platformModules`, else `Unknown platform call` at `.call`. Its module must be listed in `requires.platform`, its permissions in `requires.permissions` and its background names in `requires.background`; each error is at `.call`.                                                                                                         |
| `args`                 | Up to `MAX_PROTOTYPE_PLATFORM_ARGS` (16) entries, exactly the call's declared arguments (`Unknown argument`, `Required argument` at `.args.<name>`). Each is a value binding: `{value}`, `{state}`, `{data}`, `{platform}`, `{item}` / `{index: true}` in a repeat, and `{event}` inside a handler. A literal `{value}` must satisfy the argument's rule (error at `.args.<name>.value`). |
| `into`                 | Optional `/data/<pointer>`, the `request` rule: an object member, not an array element, so `<into>__meta` can be written beside it. `/platform` is read-only, so an `into` under it is refused. Written with `applyPrototypeDataWrite` and reported as a `change` event.                                                                                                                  |
| `statusKey`            | A declared **string** state key, moved `loading` → `success` or `error`, as for `request`.                                                                                                                                                                                                                                                                                                |
| `timeoutMs`            | Optional integer, 1 to `MAX_PROTOTYPE_PLATFORM_TIMEOUT_MS` (300000, long enough for a system picker); the default is `DEFAULT_PROTOTYPE_PLATFORM_TIMEOUT_MS` (10000).                                                                                                                                                                                                                     |
| `onSuccess`, `onError` | Optional action lists (1 to 32). They count toward `MAX_PROTOTYPE_ACTION_DEPTH`.                                                                                                                                                                                                                                                                                                          |

A failed call writes `{code, message}` to `<into>__meta.error`, with `code` one of `unsupported`,
`unavailable`, `permission_denied`, `invalid_args`, `cancelled`, `timeout`, `too_many_in_flight`
(more than `MAX_PROTOTYPE_PLATFORM_CALLS_IN_FLIGHT`, 4) or `platform_error`.
