# Prototype spec: platform actions and events

Part of [the agent-authored prototype specification](prototype-ux.md).


The platform vocabulary is the one shape every platform integration uses (notifications, media,
location, share and so on): a `platform` action calls the platform from a tap, root `platform.on`
handlers react to platform events, `{platform}` reads show live platform state, and a root
`requires` block declares up front what the spec needs. It is modelled on the `request` action.
This section is the contract and the host validation; running the calls is the device module
registries' job (#14295 on Android, #14296 on iOS), and no production runtime advertises it yet.

```json
{
  "requires": {
    "platform": ["notifications", "media"],
    "permissions": [{ "name": "notifications", "purpose": "Alerts when a new episode is out" }],
    "background": ["audio"]
  },
  "platform": {
    "on": {
      "media.ended": [{ "type": "setState", "key": "playing", "value": false }]
    }
  }
}
```

```json
{
  "type": "platform",
  "call": "notifications.post",
  "args": { "title": { "value": "New episode" }, "body": { "data": "/episodes/0/title" } },
  "into": "/data/lastPost",
  "statusKey": "postStatus",
  "timeoutMs": 5000,
  "onSuccess": [],
  "onError": []
}
```

**Modules.** The contract's top-level `platformModules` table is the single source for every call
and event: each module names its capability, and each call its arguments (with the contract rule
a literal `{value}` argument must satisfy), the permissions and background names it needs, and a
`sensitive` flag for the threat model (#14293). The validators and the capability gates read the
table, so a module is added by adding its entry. The placeholder module `test` (`test.echo`,
`test.protected`, the `test.tick` event, capability `prototype_platform_test_v1`) makes the
vocabulary testable before any real module exists; no production runtime advertises it.

**Per-call capabilities.** A `platformModules` call may name a `capability` it needs on top of its
module's, named `prototype_platform_<module>_<op>_vN`. The host, Kotlin and Swift validators add it to
a spec's required capabilities wherever the call appears, so a runtime can offer a module but refuse
one of its operations (camera recording, system capture, media queues).

**`requires`** is optional and strict. `platform` lists module names (1 to 32, unique, each in
`platformModules`, else `Unknown platform module`). `permissions` lists `{name, purpose}` entries
(1 to 16, names unique): `name` is one of the canonical permissions of #14297 (`camera`,
`microphone`, `location`, `locationBackground`, `notifications`, `photos`, `photosAdd`, `contacts`,
`calendar`, `bluetooth`, `nearbyWifi`, `motion`, `speech`) and `purpose`, a nonblank string of at
most 512 characters, becomes the iOS usage string and the Android rationale. `background` lists
the canonical background names of #14301 (`audio`, `location`, `call`, `connectedDevice`,
`transfer`, `camera`, `microphone`, `remoteNotification`). The host reads `requires` before show
for the gates below, and the disposable-app shell (#14184) derives its manifest and Info.plist from
it.

**Events.** `platform.on` maps `"<module>.<event>"` names (up to `MAX_PROTOTYPE_PLATFORM_HANDLERS`, 32) to action lists. An unknown event is refused at `platform.on["<name>"]`, and its module must be
declared. A handler runs atomically under the interaction lock, like a tap, and may use `push` /
`pop`, data and state actions and `platform` calls. Only inside a handler, `{event: "/pointer"}`
reads the delivered event's data, scoped the way `{item}` is scoped to a repeat; anywhere else it
is refused with `{event} is only available inside a platform.on handler`.

**Platform state** is device-owned JSON under `/platform/<module>/...` (for example
`/platform/permissions/camera`), at most `MAX_PROTOTYPE_PLATFORM_STATE_BYTES` (65536). It is read
with a `{platform:/pointer}` text placeholder, a `{platform: pointer}` value binding and a
`{platform: pointer, equals | notEquals | gt | lt}` condition, parallel to the `{data}` forms; the
pointer's first segment names the module, which must be declared. It is not patchable, not
storable and not part of the `/data` revision log.

**Reported events.** No wire field is added. A finished call is an `emit` named
`prototype_platform` with payload `{callId, call, outcome, error?, durationMs, simulated?}`, sent
after the `into`, `__meta` and `statusKey` writes and before `onSuccess` / `onError`. A delivered
event is an `emit` named `prototype_platform_event` with payload `{event, data, truncated?,
simulated?}`, `data` cut to the 4 KiB emit budget with `truncated: true`. Await them with
`awaitEvent {kind: "emit", eventName: "prototype_platform"}`; a malformed payload is dropped, as for
requests (`prototypePlatformEvent.ts`). Authored emit names cannot start with `prototype_`, which
generalizes the single reserved `prototype_request` name.

**Device state.** The `device` module exposes `/platform/device/widthClass` on both
platforms: Android reports Material `compact` (<600dp), `medium` (600–839dp), or
`expanded` (>=840dp); iOS reports `compact` or `regular` directly from
`horizontalSizeClass`, independent of window width. There is no `sizeClass` key;
`heightClass` and `posture` remain Android-only. Declare `device` in
`requires.platform` and branch on `/device/os` for platform-specific layouts.
The contract's `value` rule supplies the default and `valueByPlatform` overrides
it for the named platform. Spec validators have no target-platform input and
accept the union of those rules for `equals` and `notEquals`, so portable specs
can contain branches for either platform. Consequently, an `expanded` comparison
is valid portable syntax even when loaded on iOS; it never matches an iOS snapshot.

**Capabilities.** `prototype_platform_v1` gates `requires`, `platform.on`, the `platform` action and
`{platform}` reads; each module adds `prototype_platform_<module>_v1`, and a later op or event gets
a `_v2` gate that checks the fields that version introduced. The gates are generated from
`platformModules` and join `PROTOTYPE_SPEC_CAPABILITY_GATES`, so show, patch and `replaceNode`
refuse uniformly. Because every module use must be declared in the root `requires`, which a patch
cannot add, a patch never introduces a module the shown spec did not already require.

Android's renderer accepts an identity-stable `PrototypePlatform` containing an immutable module
registry. The host supplies modules; it retains ownership and closes them after all surfaces detach.
The built-in device module projects the host's measured window state. Each surface subscribes to
module state and events, and the controller shares a four-call limiter across its surfaces. Calls
resolve arguments at invocation, wait outside the interaction lock, and commit result, metadata,
status, outcome event and follow-ups under that lock. Replacement, reset and dismissal cancel calls;
cancellation reports an outcome without running follow-ups. CtrlProxy registers only the device
module in release; debug additionally registers the permission-free test module.

The shared fixtures `test/fixtures/prototype-spec/valid/platform-*.json` and
`invalid/platform-*.json` are replayed by the TypeScript, Kotlin and Swift validators.
