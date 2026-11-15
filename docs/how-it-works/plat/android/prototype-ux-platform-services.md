# Prototype spec: commerce, secure storage, sensors, permissions and notifications

Part of [the agent-authored prototype specification](prototype-ux.md).

**Sandbox commerce (#14314).** The `commerce` module (`prototype_platform_commerce_v1`) has two calls.
The `commerce.purchase` call takes a required `productId` (an identifier of at most 64 characters) and writes
`{status, transactionId}` into `into`, where `status` is `purchased`, `deferred` or `pending`. A back-out is the
typed error `cancelled`. The `commerce.restore` call takes no arguments. The `commerce.entitlementsChanged` event and the
read-only keys `/platform/commerce/entitlements` and `/platform/commerce/lastTransaction` complete the module.
No argument carries an amount, merchant, key or card: prices come only from the catalog.

The root `commerce` catalog (needs `commerce` in `requires.platform`) is `{backend: "fake", products}` with 1 to
32 products. Each product has a unique `id` (an identifier), a `title`, a `kind` (`consumable`, `nonConsumable`
or `subscription`) and a `price`. The price has a decimal-string `amount` (up to two decimal places) and an
upper-case three-letter `currency`. Only a subscription may have a `period` or `trialPeriod`, an ISO 8601 duration of
whole days, weeks, months or years (`P7D`, `P1M`). The block has no merchant, gateway, key, card or URL field.
Every `commerce.*` call needs the catalog, and a literal `productId` must name one of its products.
The contract has no `commerce.checkout`, and no production runtime advertises the module.

The fake store's state follows one reducer, `prototypePurchaseOutcome.ts`. Kotlin and Swift `PrototypePurchaseOutcome`
copy it, and all three replay `test/fixtures/prototype-purchase/`. The `entitlements` key maps a product id to `active`,
`gracePeriod` or `billingRetry`, and a consumable never holds one. The `lastTransaction` key is
`{transactionId, productId, status}`, or null. Buying a product that is `active` or in `gracePeriod` fails
with `alreadyOwned`, whatever outcome was queued; a product in `billingRetry` can be bought again. A product
the catalog does not list is `platform_error` with reason `unavailable`. A failed purchase leaves the state
untouched. A code other than `cancelled`, `alreadyOwned` or `platform_error` becomes `platform_error`, and only
`platform_error` keeps a reason: `network`, `declined` or `unavailable`.

The store records every result as `lastTransaction`, but only `purchased` grants the entitlement. A
`deferred` or `pending` transaction resolves later: `approved` grants the entitlement and `declined`
records `declined`. Simulated `entitlementsChanged` events work on a subscription the user holds. The
`renew` event sets it `active`, and `gracePeriod` and `billingRetry` set those states. The `expire` and
`refund` events remove an entitlement and also apply to a non-consumable. The module raises
`commerce.entitlementsChanged` only when the entitlements actually change.

**Secure storage (#14321).** The `storage.secure` field lists up to 8 `state:` keys the runtime keeps in the Android
Keystore or the iOS Keychain instead of plaintext storage. Each must be a declared state key holding a string,
and it may not also appear in `storage.keys`. The list needs the `secureStorage` module
(`prototype_platform_secureStorage_v1`) in `requires.platform`. Its one read-only key,
`/platform/secureStorage/locked`, is true while a biometric-bound key is still locked.
A `secureAuth: {"state:<key>": "biometric"}` entry binds a secure key to a `biometric.authenticate` and needs `biometric`
in `requires.platform`. A secure key never leaves the device through an emit `context`: the validators refuse
`{state: <secure key>}` there. A `request` may send one only with `allowSecureInRequest: true`. Otherwise the
validators refuse a `{state: <secure key>}` binding in a header, query value or body (whole, form entry or
multipart value), or a `{<secure key>}` placeholder in the URL, a header or a query value.

On a show, `restorePrototypeStorage` and its Kotlin and Swift twins apply the secure store's values under the
same version and listing rules. A value restores only into a listed secure key, as a string of at most
`MAX_PROTOTYPE_SECURE_VALUE_BYTES` (4096) UTF-8 bytes into a string state key, and a plaintext stored copy
never fills one. The runtime does not read a biometric-bound key that holds a value: its state holds `""` and
`locked` reports it until `biometric.authenticate` unlocks it. The runtime drops a key the store reports
invalidated (biometric re-enrolment revoked its hardware key), and the spec's value stands. No production
runtime advertises the module yet.

**Motion and sensors (#14327).** The `sensors` module (`prototype_platform_sensors_v1`) has no calls and one
event, `sensors.shake`, handled in `platform.on`. Its read-only keys are flat, because a `/platform` pointer reads
exactly one `/<module>/<key>`. The keys are `pitchDeg` and `rollDeg` (whole degrees, -180 to 180), `headingDeg` (0 to 359),
`steps` (counted since the subscription started), `proximityNear` (boolean) and `lightLux` (whole lux, Android
only). There is no public ambient-light API on iOS. A sensor the device lacks leaves its key absent, so it compares as
missing. The `prototypeSensorReference.ts` module is the reference the runtimes copy: whole-unit rounding, per-key
throttling at `1000 / rateHz` ms (`rateHz` 1 to 30), and a shake at 2.7 g or more with a 1000 ms cooldown.
The runtimes replay it from `test/fixtures/prototype-sensors/`.

The root `sensors` block lists the sensors the device listens to, and needs `sensors` in `requires.platform`.
In it, `shake`, `steps` and `proximity` take `{}`, while `orientation` (the three degree keys) and `light` take an optional
`rateHz` of 1 to 30. The `steps` sensor also needs the `motion` permission in `requires.permissions`. A `/platform/sensors`
read or a `sensors.shake` handler must name a sensor the block lists. No production runtime advertises the
module.

**Voice notes (#14194, contract only).** The `audioRecorder` module
(`prototype_platform_audioRecorder_v1`) records from the microphone, so every call needs `microphone`
in `requires.permissions`. The `audioRecorder.start` call takes an optional `maxDurationMs` (whole number
1-300000). The `audioRecorder.stop` call writes an `audio/mp4` device media item with `durationMs` to `into`,
and `audioRecorder.cancel` discards the recording. The `/platform/audioRecorder/status` key is `recording`,
`stopped`, `permission_denied`, `unavailable` or `error` (also delivered as
`audioRecorder.statusChanged`). The `level` key is 0-1 and updates at most 10 times a second, and `elapsedMs`
counts the current recording. A press-and-hold control uses the gesture action lists, and playback
uses a `media` audio player. No production runtime advertises the module yet.

**Runtime permissions (#14297).** Canonical names live in `requires.permissions[].name`, and each entry's
`purpose` becomes the iOS usage string and the Android rationale text. The `schemas/prototype-platform-permissions.json`
file maps each name to its Android manifest permissions and grant mechanism, and to its iOS Info.plist usage key and
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

The `permissions` module (`prototype_platform_permissions_v1`) has one call, `permissions.request` with
`names` (1-16 unique canonical names). A literal list may only name permissions declared in
`requires.permissions`; a bound list is checked by the runtime. State is `/platform/permissions/<name>`, one
of `granted`, `denied`, `blocked`, `notDetermined`, `limited`, `restricted` or `unavailable`, and
`permissions.changed` fires when the user changes a permission in Settings and the app resumes. A call that
needs a permission the user denied fails with `permission_denied` and never prompts implicitly. Overlay
runtimes do not advertise the module, since a grant there would go to CtrlProxy or the borrowed host app.

The host sets declared permissions after install and before launch, so the first frame shows the final
state. The mode is `prompt`, `grantDeclared`, or `{grant: [...], deny: [...]}` naming declared
permissions only, each in one list. The `prompt` mode is the default for interactive shows: nothing is
granted, so the first request shows the system dialog and plans rely on the system-alert policy (#14106). Tests and agent loops pass
an explicit mode. An Android denial revokes with the `user-fixed` flag, so it reads `blocked` and no dialog
appears; an iOS simulator denial is `simctl privacy revoke` and reads `denied`. Each declared permission is
reported as `{name, state, verified}`; `verified` is false, with `reason`, for a simulator name that is
notGrantableOnSimulator and for an Android `photosAdd` denial (`notRevocable`). No production runtime
advertises the module, and `prototype show` does not yet accept the mode.

**Notifications (#14280).** The `notifications` module (`prototype_platform_notifications_v1`) has three
calls:

- `notifications.post` takes `id` (1-128 characters), `channel` (a key-shaped channel id) and `title`
  (non-blank, at most 128). Its optional arguments are `body` (at most 1024), `largeImage` (an asset id),
  `style`, `group`, `badge` (whole number 0-9999), `data`, `actions`, `progress`, `silent` and `ongoing`.
  The `data` argument is JSON, at most 1 KiB, echoed in every event for the notification.
- `notifications.cancel` takes `id`, `group` or `all: true`.
- `notifications.setBadge` takes `count` (0-9999).

The `style` argument is discriminated by `type`, like every other union in the spec. It is `bigText`,
`bigPicture` with `image`, `inbox` with 1-6 `lines` and an optional `summary`, or `messaging`. A
`messaging` style has `self`, an optional `conversationTitle` and 1-7 `messages` of
`{from?, text, image?}`, where an absent `from` is the user. The `actions` argument holds 1-3 buttons of
`{id, label, opensApp?, reply?: {placeholder?}}`, and `progress` is `{value: 0..1}` or
`{indeterminate: true}`. The `post` and `setBadge` calls need `notifications` in `requires.permissions`;
`cancel` does not. Events are `notifications.opened`, `.action`, `.reply` (marked sensitive, since it
carries typed text) and `.dismissed`.

State is `/platform/notifications/{badge, active, pending, authorization}` plus
`/platform/notifications/channels/<id>/blocked` (a boolean, readable only for a declared channel). The
`active` key is at most 24 per prototype, and `authorization` uses the permission vocabulary (`granted`,
`denied`, `blocked`, `notDetermined`, `limited`, `restricted`, `unavailable`). The runtime homes follow
the owner decision on #14276: the disposable app, the iOS per-prototype Viewer and ProtoViewer advertise
the module. The CtrlProxy overlay advertises it as a disclosed preview, and the iOS injected agent never
does.

Channels come from a root `notifications` block,
`{channels: [{id, name, importance, description?, showBadge?}]}`. It holds 1-8 channels with unique
key-shaped ids, a non-blank `name` (at most 64), `importance` one of `min`, `low`, `default` or `high`,
and an optional `description` (at most 256). The block needs `notifications` in `requires.platform`. A
literal `channel` on `notifications.post` must name a declared channel, and a literal `actions` list
needs unique ids. The `notifications.cancel` call takes exactly one of `id`, `group` or `all`; the
runtime checks bound values. On iOS, `min` and `low` map to the passive interruption level and
`default` and `high` to active.

The bounds are named contract limits (`MAX_PROTOTYPE_NOTIFICATION_*`,
`MAX_PROTOTYPE_NOTIFICATIONS_ACTIVE`) that the call, state and channel rules repeat. Spec validation
checks literal values only. The limits that apply after placeholders resolve belong to the device
runtime that posts the notification. They are a reply of at most 1 KiB, a resolved notification of at
most 5 KiB, and at most 4 updates per second per notification, coalesced to the latest. No runtime
posts notifications yet, so none of these is enforced today; the host never posts one.

The module's report (#14277) is `{permission, badge, channels, active, pending}`.
`prototypeNotificationsReport` builds it from a platform snapshot: Android's active notifications, or
iOS's delivered and pending requests. It keeps only `proto:<id>` tags and reports them as `id`. The
Kotlin and Swift `PrototypeNotificationsReport` twins replay
`test/fixtures/prototype-notifications/report.json`. No runtime sends the report yet, so `status` and
`inspect` do not show it.

Title and body limits count UTF-16 code units. The 5 KiB total counts UTF-8 bytes of the resolved
title, body and `data`, and is meant to fail the call on its own (`invalid_args` when over). A code
unit is at most 3 bytes, so every literal at the per-field limits fits (at most 4,480 bytes). Text
bound at post time can still exceed it, such as emoji counted per character (5,632 bytes at the
limits).

The `notifications.schedule` call takes the `post` arguments plus `delaySeconds` (a whole number,
1 to 604800) and needs `prototype_platform_notifications_scheduled_v1` as well. The same channel and
action-id rules apply, and `notifications.scheduledFired` reports a scheduled notification that fired
(#14283).

A `notifications.push` handler receives a simulated push (`{type, data, notification?}`, at most 4096
bytes of compact JSON, the APNs limit). It needs `prototype_platform_push_v1` on top of the module,
gated per event rather than per call (#14285). The host delivers one with
`prototype {action: "simulate", id, event: "notifications.push", data, transport?}`. It validates the
payload first (`invalid_args`), then `auto` picks the live `connection` before the `system` push path.
The result reports `transport`, `handled` and `delivery`, or `code: "unavailable"` when neither route
exists. No runtime supplies a route yet, so every device answers `unavailable`. The runtime-neutral
expectations live in `test/fixtures/prototype-spec/push/traces.json`. No production runtime advertises
the module yet.
