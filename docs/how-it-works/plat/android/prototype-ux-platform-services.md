# Prototype spec: commerce, secure storage, sensors, permissions and notifications

Part of [the agent-authored prototype specification](prototype-ux.md).

**Sandbox commerce (#14314).** `commerce` module (`prototype_platform_commerce_v1`) has two calls.
`commerce.purchase` takes a required `productId` (at most 64 characters) and writes
`{status, transactionId}` into `into`, where `status`: `purchased`, `deferred` or `pending`. A back-out is the
typed error `cancelled`. `commerce.restore` takes no arguments. `commerce.entitlementsChanged` event and the
read-only keys `/platform/commerce/entitlements` and `/platform/commerce/lastTransaction` complete the module.
No argument carries an amount, merchant, key or card: prices come only from the catalog.

The root `commerce` catalog (needs `commerce` in `requires.platform`): `{backend: "fake", products}` with 1-32
products. Each product has a unique `id`, a `title`, a `kind` (`consumable`, `nonConsumable`
or `subscription`) and a `price`. The price has a decimal-string `amount` (up to two decimal places) and an
upper-case three-letter `currency`. Only a subscription may have a `period`/`trialPeriod`, an ISO 8601 duration of
whole days, weeks, months or years (`P7D`, `P1M`). The block has no merchant, gateway, key, card or URL field.
Every `commerce.*` call needs the catalog; a literal `productId` must name one of its products.
The contract has no `commerce.checkout`; no production runtime advertises the module.

The fake store's state follows one reducer, `prototypePurchaseOutcome.ts`. Kotlin/Swift `PrototypePurchaseOutcome`
copy it; all three replay `test/fixtures/prototype-purchase/`. `entitlements` key maps a product id to `active`,
`gracePeriod`/`billingRetry`; a consumable never holds one. `lastTransaction` key is
`{transactionId, productId, status}`, or null. Buying an `active`/`gracePeriod` product fails
with `alreadyOwned`, whatever outcome was queued; a `billingRetry` product can be bought again. A product
the catalog does not list is `platform_error` with reason `unavailable`. A failed purchase leaves the state
untouched. Any code other than `cancelled`, `alreadyOwned` or `platform_error` becomes `platform_error`; only
`platform_error` keeps a reason: `network`, `declined`/`unavailable`.

The store records every result as `lastTransaction`; only `purchased` grants the entitlement. A
`deferred`/`pending` transaction resolves later: `approved` grants the entitlement; `declined`
records `declined`. Simulated `entitlementsChanged` events work on a subscription the user holds. The
`renew` event sets it `active`; `gracePeriod`/`billingRetry` set those states.
`expire`/`refund` events remove an entitlement and apply to a non-consumable. The module raises
`commerce.entitlementsChanged` only when the entitlements change.

**Secure storage (#14321).** `storage.secure` lists up to eight declared string `state:` keys,
separate from `storage.keys`. It requires `secureStorage` in `requires.platform` and
`prototype_platform_secureStorage_v1`. ProtoViewer, saved-prototype Activities and the disposable
app shell register the module. CtrlProxy's injected overlay and unsupported embedded hosts refuse it.
The module has no calls; `/platform/secureStorage/locked` is false. Biometric-bound `secureAuth`
keys stay live-only: this runtime neither persists nor restores them.

Each value is limited to 4096 UTF-8 bytes and excluded from the plaintext document and its byte
budget. An app-private file under `prototype-storage/secure/` holds a Base64-encoded AES-GCM
ciphertext with a fresh random 12-byte IV. The 256-bit AES key stays in AndroidKeyStore under
`dev.automobile.prototype.<slug>-<full-id-sha256>`, without user authentication. The full id
authenticates the ciphertext; ProtoViewer isolates duplicate imports by library entry id.
Writes sync a temporary file before atomic replacement. Missing or unusable keys and corrupt
ciphertext leave values absent with a fixed warning carrying no payload/exception details.

The [storage precedence and clearing rules](prototype-ux-storage.md) apply to both stores.
Reset, `clearStorage` and deletion remove the secure file and its Keystore alias; dismissal retains
them. Status, inspect, patch conflicts and events (including `change` payloads) omit secure values.
Storage reports add optional `secure: [{key, present, bytes}]` metadata. Neither values nor
ciphertext appear in reports or runtime warnings.

Secure keys cannot bind into an emit `context` or, in host validation, a data-write `{state}`
value. Requests may reference them only with `allowSecureInRequest: true`; otherwise validation
refuses state bindings and text placeholders in URLs, headers, query values and bodies. See [request bindings](prototype-ux-request.md).

**Motion and sensors (#14327).** `sensors` module (`prototype_platform_sensors_v1`) has no calls and one
event, `sensors.shake`, handled via `platform.on`. Its read-only keys are flat: a `/platform` pointer reads
exactly one `/<module>/<key>`. Keys: `pitchDeg`/`rollDeg` (whole degrees, -180 to 180), `headingDeg` (0-359),
`steps` (counted since the subscription started), `proximityNear` (boolean) and `lightLux` (whole lux, Android
only). iOS has no public ambient-light API. A sensor the device lacks leaves its key absent, comparing as
missing. The runtimes copy whole-unit rounding from `prototypeSensorReference.ts`. Continuous values use per-key
throttling at `1000 / rateHz` ms (`rateHz` 1-30). A shake needs 2.7 g or more with a 1000 ms cooldown.
On iOS, every distinct proximity change publishes immediately; identical consecutive values are ignored.
The runtimes replay it from `test/fixtures/prototype-sensors/`.

The root `sensors` block lists the sensors the device listens to, and needs `sensors` in `requires.platform`.
In it, `shake`, `steps` and `proximity` take `{}`, while `orientation` (the three degree keys) and `light` take
an optional `rateHz` of 1-30. `steps` sensor needs the `motion` permission in `requires.permissions`. A `/platform/sensors`
read or a `sensors.shake` handler must name a sensor the block lists. Android CtrlProxy advertises the module
using platform sensors, subscribing only while the prototype is active and in the foreground. Steps
remain absent without an `ACTIVITY_RECOGNITION` grant; the module does not request it.

The iOS agent, ProtoViewer/Viewer registries advertise the module using CoreMotion/UIKit proximity monitoring.
Steps require `NSMotionUsageDescription`, available step counting and non-denied, non-restricted
motion authorization. `CMPedometer` source counts steps from each subscription's start date; its first callback
includes steps since then; restarting resets the baseline. Orientation uses
magnetic north when available, omitting an invalid heading. CoreMotion converts acceleration from g to m/s²
before shake detection. iOS never subscribes to or publishes light readings. Each iOS presentation owns its
sensor state and subscriptions, sharing motion and proximity hardware until their final user stops.
Hiding, replacing or re-showing it, with an identical block/reset, stops its subscriptions and clears
state, filters and the shake cooldown. Stopped subscriptions cannot publish into a later session.

**Android biometric runtime support.** Android Activity hosts (SavedPrototypeActivity, ProtoViewer and disposable
apps) register the [biometric module](prototype-ux-platform-device.md). CtrlProxy overlays omit the capability and
refuse these specs before show. Failures use `cancelled`, or `unavailable` with reason `lockout`,
`not_enrolled` or `no_hardware`. Only a foreground Activity can start a prompt. Cancellation, timeout
and host teardown dismiss it.

API 28 checks only `PackageManager.FEATURE_FINGERPRINT` before showing the prompt; a missing feature
returns `unavailable` with reason `no_hardware`. With that feature present, enrollment/lockout
errors come from the prompt callback. API 29 adds device credentials; API 30 selects
`BIOMETRIC_STRONG | DEVICE_CREDENTIAL` when requested. Earlier Android versions and credential
fallback on API 28 report `no_hardware`.

**Voice notes (#14194, contract only).** `audioRecorder` module
(`prototype_platform_audioRecorder_v1`) records from the microphone, so every call needs `microphone`
in `requires.permissions`. `audioRecorder.start` takes an optional `maxDurationMs` (whole number
1-300000). The `audioRecorder.stop` writes an `audio/mp4` device media item with `durationMs` to `into`;
`audioRecorder.cancel` discards the recording. `/platform/audioRecorder/status` key: `recording`,
`stopped`, `permission_denied`, `unavailable`/`error` (delivered as
`audioRecorder.statusChanged`). Its `level` key is 0-1, updating at most 10 times a second; `elapsedMs`
counts the current recording. A press-and-hold control uses the gesture action lists; playback
uses a `media` audio player. No production runtime advertises the module yet.

**Runtime permissions (#14297).** Canonical names live in `requires.permissions[].name`; each entry's
`purpose` becomes the iOS usage string and the Android rationale text. Its `schemas/prototype-platform-permissions.json`
file maps each name to its Android manifest permissions and grant mechanism, and its iOS Info.plist usage key and
`simctl privacy` service:

| Name                 | Android manifest                                 | Android grant     | iOS usage key                                  | `simctl privacy`        |
| -------------------- | ------------------------------------------------ | ----------------- | ---------------------------------------------- | ----------------------- |
| `camera`             | `CAMERA`                                         | `pm grant`        | `NSCameraUsageDescription`                     | `camera`                |
| `microphone`         | `RECORD_AUDIO`                                   | `pm grant`        | `NSMicrophoneUsageDescription`                 | `microphone`            |
| `location`           | `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION` | `pm grant`        | `NSLocationWhenInUseUsageDescription`          | `location`              |
| `locationBackground` | `ACCESS_BACKGROUND_LOCATION`                     | `pm grant`        | `NSLocationAlwaysAndWhenInUseUsageDescription` | `location-always`       |
| `notifications`      | `POST_NOTIFICATIONS`                             | app setting       | none                                           | notGrantableOnSimulator |
| `photos`             | `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`          | `pm grant`        | `NSPhotoLibraryUsageDescription`               | `photos`                |
| `photosAdd`          | none                                             | none (MediaStore) | `NSPhotoLibraryAddUsageDescription`            | `photos-add`            |
| `contacts`           | `READ_CONTACTS`                                  | `pm grant`        | `NSContactsUsageDescription`                   | `contacts`              |
| `calendar`           | `READ_CALENDAR`, `WRITE_CALENDAR`                | `pm grant`        | `NSCalendarsFullAccessUsageDescription`        | `calendar`              |
| `bluetooth`          | `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT`            | `pm grant`        | `NSBluetoothAlwaysUsageDescription`            | notGrantableOnSimulator |
| `nearbyWifi`         | `NEARBY_WIFI_DEVICES`                            | `pm grant`        | `NSLocalNetworkUsageDescription`               | notGrantableOnSimulator |
| `motion`             | `ACTIVITY_RECOGNITION`                           | `pm grant`        | `NSMotionUsageDescription`                     | `motion`                |
| `speech`             | `RECORD_AUDIO`                                   | `pm grant`        | `NSSpeechRecognitionUsageDescription`          | notGrantableOnSimulator |

`permissions` module (`prototype_platform_permissions_v1`) has one call, `permissions.request` with
`names` (1-16 unique canonical names) and optional `options: {provisional?: boolean}` (default false).
Android accepts and ignores these options. A literal list may only name permissions declared in
`requires.permissions`; the runtime checks a bound list. State: `/platform/permissions/<name>`, one
of `granted`, `denied`, `blocked`, `notDetermined`, `limited`, `restricted`/`unavailable`, and
`permissions.changed` carries `{name, state}` when a request changes authorization. It fires when
the user changes a permission in Settings and the app resumes. A call needing a permission the user denied fails with `permission_denied` and never prompts implicitly. Overlay
runtimes do not advertise the module: a grant there would go to CtrlProxy or the borrowed host app.

iOS standalone hosts and ProtoViewer register `permissions` for `notifications`; borrowed-app sessions
do not expose the module. Other canonical names return `unavailable`.
The first status read establishes `/platform/permissions/notifications` asynchronously without prompting.
Requests and foreground Settings re-reads publish only changed states. A request uses alert,
sound and badge options only while authorization is `notDetermined`; `options.provisional: true` adds
provisional authorization without showing a prompt, re-reading notification settings
for its result. Outside an app bundle with a bundle
identifier, the source returns `unavailable` without accessing UserNotifications. No Info.plist key is
required.

One request may be in flight per module; a second returns `too_many_in_flight`. Request
cancellation drops the late result while foreground observation stays active. Observation stops
when its final observer releases it. Permission requests have no platform-call deadline,
including an explicit `timeoutMs`; `statusKey` stays `loading` until a result or cancellation.
The same state is published at `/platform/notifications/authorization`, including the baseline and
foreground re-reads, and cleared on stop. An authorization-only binding declares `notifications` in
`requires.platform`/`requires.permissions`, using the permissions capability on iOS.
Other notification state, calls and handlers require the notifications capability.
Provisional authorization reads as `limited`.

| iOS `UNAuthorizationStatus` | State           |
| --------------------------- | --------------- |
| `notDetermined`             | `notDetermined` |
| `denied`                    | `denied`        |
| `authorized`                | `granted`       |
| `provisional`               | `limited`       |
| `ephemeral`                 | `granted`       |
| Unknown future value        | `unavailable`   |

ProtoViewer, disposable apps and CtrlProxy's SavedPrototypeActivity register `permissions` for
`notifications`. A plain Activity without an
ActivityResultRegistry and the CtrlProxy overlay omit it. Camera/microphone: see
[ProtoViewer](../../protoviewer.md#31-standalone-unprivileged-apps).
The result: `{results: {<name>: <state>}}`; each result updates `/platform/permissions/<name>`.
Bound request lists must name declared permissions, like literal lists. Only one request can be
in flight per Activity; a second returns `too_many_in_flight`. A permission prompt waits for the user
without a platform-call deadline, including an explicit `timeoutMs`; `statusKey` remains `loading`
until a result or cancellation. Cancellation, Activity destruction and teardown unregister the result
launcher and drop late callbacks. Activity resume re-reads notification authorization and emits only
changed states. Denial history is per runtime session, recorded only after a successful
launch delivers a denial, and cleared on reset, teardown or a later grant.

| Android notification authorization                                      | State           |
| ----------------------------------------------------------------------- | --------------- |
| Activity is not resumed, or source is closed                            | `unavailable`   |
| API below 33, notifications enabled                                     | `granted`       |
| API below 33, notifications disabled in Settings                        | `blocked`       |
| API 33+, POST_NOTIFICATIONS granted and notifications enabled           | `granted`       |
| API 33+, POST_NOTIFICATIONS granted but notifications disabled          | `blocked`       |
| API 33+, not granted and no denial recorded in this session             | `notDetermined` |
| API 33+, denial recorded and rationale available                        | `denied`        |
| API 33+, denial recorded and no rationale (including user-fixed denial) | `blocked`       |

`POST_NOTIFICATIONS` is a runtime permission starting at API 33. Earlier versions never prompt;
Settings alone controls notification availability. Already-granted/blocked requests return their
state without a prompt. This runtime does not publish `/platform/notifications/authorization` or
advertise the notifications module.

The host sets declared permissions between install and launch, so the first frame shows the final
state. The mode: `prompt`, `grantDeclared`, or `{grant: [...], deny: [...]}` naming declared
permissions only, each in one list. Its `prompt` mode is the default for interactive shows: nothing is
granted, so the first request shows the system dialog; plans rely on the system-alert policy (#14106). Tests and agent loops pass
an explicit mode. An Android denial revokes with the `user-fixed` flag, reading `blocked` with no dialog;
an iOS simulator denial: `simctl privacy revoke`, reading `denied`. Each declared permission is
reported as `{name, state, verified}`; `verified` is false, with `reason`, for a notGrantableOnSimulator
simulator name and for an Android `photosAdd` denial (`notRevocable`).
`prototype show` does not yet accept the mode.

**Notifications (#14280).** `notifications` module (`prototype_platform_notifications_v1`) has three
calls:

- `notifications.post` takes `id` (1-128 characters), `channel` (a key-shaped channel id) and `title`
  (non-blank, at most 128). Its optional arguments: `body` (at most 1024), `largeImage` (an asset id),
  `style`, `group`, `badge` (whole number 0-9999), `data`, `actions`, `progress`, `silent` and `ongoing`.
  Its `data` argument is JSON, at most 1 KiB, echoed in every event for the notification.
- `notifications.cancel` takes `id`, `group` or `all: true`.
- `notifications.setBadge` takes `count` (0-9999).

`type` discriminates the `style` argument, like every other spec union. It is `bigText`,
`bigPicture` with `image`, `inbox` with 1-6 `lines` and an optional `summary`, or `messaging`. A
`messaging` style has `self`, an optional `conversationTitle` and 1-7 `messages` of
`{from?, text, image?}`, where an absent `from` is the user. Its `actions` argument holds 1-3 buttons of
`{id, label, opensApp?, reply?: {placeholder?}}`; `progress` is `{value: 0..1}` or
`{indeterminate: true}`. `post`/`setBadge` calls need `notifications` in `requires.permissions`;
`cancel` does not. Events: `notifications.opened`, `.action`, `.reply` (marked sensitive, since it
carries typed text) and `.dismissed`.

State: `/platform/notifications/{badge, active, pending, authorization}` plus
`/platform/notifications/channels/<id>/blocked` (a boolean, readable only for a declared channel). The
`active` key is at most 24 per prototype; `authorization` uses the permission vocabulary (`granted`,
`denied`, `blocked`, `notDetermined`, `limited`, `restricted`, `unavailable`). Android hosts do not
advertise this module. `permissions` module above supplies notification authorization; iOS
publishes its authorization key without advertising notification delivery calls.

Channels come from a root `notifications` block,
`{channels: [{id, name, importance, description?, showBadge?}]}`. It holds 1-8 channels with unique
key-shaped ids, a non-blank `name` (at most 64), `importance` one of `min`, `low`, `default`/`high`,
and an optional `description` (at most 256). The block needs `notifications` in `requires.platform`. A
literal `channel` on `notifications.post` must name a declared channel; a literal `actions` list
needs unique ids. `notifications.cancel` takes exactly one of `id`, `group`/`all`; the
runtime checks bound values. On iOS, `min`/`low` map to the passive interruption level,
`default`/`high` to active.

The bounds are named contract limits (`MAX_PROTOTYPE_NOTIFICATION_*`,
`MAX_PROTOTYPE_NOTIFICATIONS_ACTIVE`) the call, state and channel rules repeat. Spec validation
checks literal values only. Limits applying after placeholders resolve belong to the device
runtime that posts the notification. They are a reply of at most 1 KiB, a resolved notification of at
most 5 KiB, and at most 4 updates per second per notification, coalesced to the latest. Only the
per-prototype iOS Viewer posts notifications, so the limits go unenforced elsewhere.

The iOS Viewer posts local notifications under its own bundle identity and advertises both
`prototype_platform_notifications_v1` and `prototype_platform_notifications_scheduled_v1`, so
`notifications.schedule` specs pass preflight. It uses one request identifier per prototype and notification
id, cancelling matching delivered/scheduled requests by id, group, or all. Pending requests reserve
space in the active limit because iOS can deliver them while the Viewer is suspended. The module reports the
Viewer's authorization state. The launch delegate presents foreground notifications and routes taps, buttons
and replies to the prototype, queuing cold-start responses until its event stream is ready. The injected
agent directs notification-requiring specs to the standalone Viewer.

The module's report (#14277) is `{permission, badge, channels, active, pending}`.
`prototypeNotificationsReport` builds it from a platform snapshot: Android's active notifications, or
iOS's delivered/pending requests. It keeps only `proto:<id>` tags and reports them as `id`. The
Kotlin/Swift `PrototypeNotificationsReport` twins replay
`test/fixtures/prototype-notifications/report.json`. No runtime sends the report yet, so `status` and
`inspect` do not show it.

Title and body limits count UTF-16 code units. The 5 KiB total counts UTF-8 bytes of the resolved
title, body and `data`, failing the call on its own (`invalid_args` when over). A code
unit is at most 3 bytes, so every literal at the per-field limits fits (at most 4,480 bytes). Text
bound at post time can exceed it, such as emoji counted per character (5,632 bytes at the limits).

`notifications.schedule` takes the `post` arguments plus `delaySeconds` (a whole number,
1-604800) and needs `prototype_platform_notifications_scheduled_v1`. The same
channel/action-id rules apply; `notifications.scheduledFired` reports a scheduled notification that fired
(#14283).

A `notifications.push` handler receives a simulated push (`{type, data, notification?}`, at most 4096
bytes of compact JSON, the APNs limit). It needs `prototype_platform_push_v1` besides the module,
gated per event, not per call (#14285). The host delivers one with
`prototype {action: "simulate", id, event: "notifications.push", data, transport?}`. It validates the
payload first (`invalid_args`), then `auto` picks the live `connection` before the `system` push path.
The result reports `transport`, `handled`/`delivery`, or `code: "unavailable"` when neither route
exists. No runtime supplies a route yet, so every device answers `unavailable`. The runtime-neutral
expectations live in `test/fixtures/prototype-spec/push/traces.json`. No production runtime advertises
the module yet.
