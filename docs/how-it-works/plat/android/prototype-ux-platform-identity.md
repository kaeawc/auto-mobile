# Prototype spec: links, media pickers, sign-in and location

Part of [the agent-authored prototype specification](prototype-ux.md).

**Outbound links (#14238).** The `links` module (`prototype_platform_links_v1`) has one call, `links.open`
with `url` (required, at most 2048 characters) and `mode` (optional: `external`, `inApp` or `auto`). The
`openUrl` contract pattern is an allowlist: the URL must start with a lowercase `http`, `https`, `mailto`,
`tel`, `sms`, `geo` or `maps` scheme and contain no whitespace or control characters. `intent:`, `file:`,
`content:`, `javascript:`, `data:` and any custom scheme fail validation in all three validators, so a
spec cannot name a component or an arbitrary handler, and a URL that begins with a placeholder has no literal
scheme, so it fails the same pattern. `inApp` opens only `http` and `https` URLs, because Custom Tabs and
`SFSafariViewController` load only web pages: all three validators refuse a literal non-web URL with
`mode: inApp`, and the Android and iOS runtimes refuse the same pair as `invalid_args` once bound arguments
resolve. The module has no events or `/platform` state.

CtrlProxy registers the Android `links` runtime and advertises the capability; the embedded renderer
leaves the module to its host app. An omitted `mode` is `auto`. `tel:` starts `ACTION_DIAL` (never
`ACTION_CALL`, so no call is placed and no `CALL_PHONE` is needed), `mailto:` and `sms:` start
`ACTION_SENDTO` (a composer; nothing is sent), and every other scheme starts `ACTION_VIEW`, always with
`FLAG_ACTIVITY_NEW_TASK` because the overlay is not an activity. Only `http` and `https` can open in a
Custom Tab. The Custom Tab intent targets one Custom Tabs browser, the default browser when it provides
them and otherwise the first that does, so an App Link app cannot take the URL. The runtime writes the
Custom Tabs session extra itself, so CtrlProxy needs no `androidx.browser` dependency. `inApp` with no Custom Tabs service (AOSP images without Chrome) opens
externally and reports `outcome: "fallback"`; `auto` makes the same choice and reports `opened`. Success
writes `{outcome, url, mode, handler?}`, where `url` is cut to 2048 characters, `mode` is how the URL
actually opened (`external` or `inApp`) and `handler` is the resolved package. No resolving activity
fails with `unavailable`.

On iOS the agent and Viewer registries run `links.open` with `UIApplication.open` for external opens
(its completion decides `opened` or `unavailable`; `canOpenURL` is not used, since it would need
`LSApplicationQueriesSchemes`) and `SFSafariViewController`, presented over the foreground key window's top
view controller, for `inApp` and `auto` web URLs. When nothing can present, `inApp` opens externally and
reports `fallback`. The result has no `handler`. The Simulator has no Phone or Mail app, so `tel:` and
`mailto:` report `unavailable` there.

**Media actions: system picker and camera (#14197).** Two modules start platform UI that needs no app
permission and write device media items (see "Device media items") to `into`.
`mediaLibrary` (`prototype_platform_mediaLibrary_v1`) has `mediaLibrary.pick` with `media` (required:
`images`, `videos` or `imagesAndVideos`) and `maxItems` (optional whole number 1-64, default 1; 1 writes one
item, more writes an array; Android clamps it to `MediaStore.getPickImagesMaxLimit()`). `camera.capture`
has `media` (required: `image` or `video`) and `maxDurationMs` (optional whole number 1-600000, used
only for video), and needs `prototype_platform_camera_capture_v1` on top of the `camera` module's
`prototype_platform_camera_v1`. A device with a picker but no system camera (an iOS Simulator)
advertises `mediaLibrary` and not the capture capability. Both calls are `sensitive`;
`mediaLibrary` has no events or `/platform` state. A cancel leaves `into` untouched and runs `onError`
with `cancelled`; other codes are `unavailable` (no camera; detail `missing_usage_description` when the iOS
plist key is missing), `platform_error` (detail `media_limit` or `io`) and `too_many_in_flight` (one
system-UI call per prototype at a time). No production runtime advertises either module yet.

**Photo library (#14195, calls only).** Three more `mediaLibrary` calls read and write the library
itself. `query` and `manageLimitedSelection` share `prototype_platform_mediaLibrary_query_v1`;
`save` has its own capability, so a runtime can offer save without read:

- `mediaLibrary.query` (`media` as for `pick`, optional `limit` 1-64) writes the newest items to
  `into` as device media items; `mediaLibrary.manageLimitedSelection` (no arguments) re-opens the
  partial-access selection. Both need `photos` in `requires.permissions` and
  `prototype_platform_mediaLibrary_query_v1`; `query` is `sensitive`.
- `mediaLibrary.save` (required `media`, an item usually bound from `/data`, and optional nonempty
  `album`) adds an item to the library and writes its saved identifier to `into`. It needs
  `photosAdd` in `requires.permissions` and `prototype_platform_mediaLibrary_save_v1`.

All three also need the module's `prototype_platform_mediaLibrary_v1`; no production runtime
advertises the per-call capabilities yet.

**Fake sign-in (#14303).** The `auth` module (`prototype_platform_auth_v1`) has two calls. `auth.signIn` takes
an optional `style` (`chooser` or `button`), shows a runtime-owned "Simulated sign-in" sheet and writes
`{userId, name, email}` into `into`; it is `sensitive`, and a back-out is the typed error `cancelled`.
`auth.signOut` takes no arguments. The `auth.sessionExpired` event and the read-only keys
`/platform/auth/signedIn` (boolean) and `/platform/auth/userId` complete the module. No argument or key carries
a password, secret or session token: the runtime keeps the token in the Keystore or Keychain and never exposes
it. The accounts come from a root `auth` block, which needs `auth` in `requires.platform`:
`{provider: "fake", accounts, sessionTtlSeconds?}`. `accounts` holds 1 to 8 entries of `{id, name, email,
avatar?}` with unique ids. Each email must use a reserved domain (`example.test`, `example.com` or any
`.invalid`), so a fake account can never match a real one. No field holds a password, secret or client id.
`sessionTtlSeconds` runs from 60 to 2592000. An `auth.signIn` or `auth.signOut` call without the block fails
validation. No production runtime advertises the module yet.
`prototypeAuthSession.ts` is the session reference both runtimes copy. A sign-in writes the account to `into`
(default `/data/session`) and then saves `{token, userId, expiresAtMs}` in the prototype's secure store. The
token is an opaque `fake-<IdGenerator id>`, and the TTL is `sessionTtlSeconds`, default 3600. An account the
block does not list, a `/data` write that fails or a store write that fails is `platform_error` and changes
nothing. `cancelled` and `unavailable` keep their codes, any other code becomes `platform_error`, and a
failed sign-in keeps the previous session. `auth.signOut` clears the store and removes `into`.
`auth.sessionExpired` clears the store and leaves `/data` to the `platform.on` handlers. At launch, a session
that is still valid for a listed account restores `/platform/auth`; any other is cleared. A session past its
TTL is reported as expired, so the runtime raises `auth.sessionExpired`. The token appears in no result,
`/data` value or `/platform` key, and a store error is reported by its name only.

**Location (#14324).** The `location` module (`prototype_platform_location_v1`) has one call,
`location.request` with `accuracy` (optional: `precise` or `approximate`) and `maxAgeMs` (optional, whole
milliseconds, 0 to one day). The call needs `location` in `requires.permissions`; `precise` maps to
`ACCESS_FINE_LOCATION` on Android and full accuracy on iOS, `approximate` to `ACCESS_COARSE_LOCATION` and
reduced accuracy. Its `into` receives `{latitude, longitude, accuracyM, altitudeM?, speedMps?, bearingDeg?,
timestampMs, approximate}`; a grant of approximate only sets `approximate: true` rather than failing. Failures
use the typed codes `permission_denied`, `unavailable` (location services off), `timeout` and `platform_error`.
The `location.updated` event and the state keys `/platform/location/current` (the last fix, a flat object) and
`/platform/location/servicesEnabled` (the system location toggle) complete the module. The call and the event
are `sensitive`. Real-device verification sets the fix with `setDeviceState.location`; the Android emulator keeps
that fix after the session ends. `applyPrototypeLocationOutcome` (`prototypeLocationOutcome.ts`) is the
reference both runtimes copy. A fix is written only when its coordinates are in range, and it carries only the
optional fields the platform reported. `<into>__meta` then gets `{durationMs, approximate}`. A failure leaves
`into` untouched and records `{durationMs, error}`: a code outside the four above becomes `platform_error`, and
only `unavailable` keeps the `disabled` reason. If the metadata cannot fit beside the fix, the fix is rolled
back. The root `location` block `{accuracy?, minIntervalMs?, minDistanceM?}` subscribes to foreground updates:
it keeps `/platform/location/current` current while the prototype is shown and raises `location.updated` for each
write, at most once per `minIntervalMs` (whole milliseconds, 1000 to one hour) and only after moving
`minDistanceM` (0 to 100 km). Like the call, the block needs `location` in both `requires.platform` and
`requires.permissions`. No updates are delivered in the background. No production runtime advertises the module.
The delivered `location.updated` event carries only `{accuracyM, approximate}`, so coordinates reach the host
only when the spec emits them or writes them into `/data`. `prototypeLocationEventSummary`
(`prototypeLocationPrivacy.ts`) is the reference the runtimes copy, with shared cases in
`test/fixtures/prototype-location/event-summary.json`. As a second layer the host's event decoder, shared by
the Android and iOS transports, reduces any decoded `location.updated` data to those two fields and logs the
names (never the values) of anything it dropped. The host mirrors the last delivered `location.updated` as `platformStatus.location`
in `prototype status` and `inspect`, like the status modules above, with `values` holding only `accuracyM` and
`approximate`: it shows that a fix is present and how accurate it is, never its coordinates. An event without a
finite, non-negative `accuracyM` and a boolean `approximate`, or cut by the emit budget, is not mirrored.

**BLE value codecs (#14266).** The `ble` module's `decode` and `encode` arguments name one of a closed list
of codecs, with no expressions: `utf8`, `hex` (lowercase out, either case in), `base64` (standard alphabet,
padded), `uint8`, `uint16le`, `int16le`, `uint32le`, `float32le`, and the decode-only SIG decoders
`gatt.battery_level` (0x2A19, 0-100) and `gatt.heart_rate_measurement` (0x2A37:
`{heartRate, sensorContact: "unsupported" | "notDetected" | "detected", energyExpended?, rrIntervalsMs?}`,
RR intervals rounded to whole milliseconds). Values are at most 512 bytes, the ATT attribute limit. Failures
are typed: `length` (wrong byte count or over the limit), `range` (a number out of range, a non-whole
integer, a non-finite float, a battery level over 100), `format` (invalid UTF-8, hex or base64, or a value
of the wrong JSON type), `decodeOnly` and `unknown`. The TypeScript reference and its Kotlin and Swift twins
replay `test/fixtures/prototype-spec/ble/codecs.json`. The module contract and runtimes are not built.
