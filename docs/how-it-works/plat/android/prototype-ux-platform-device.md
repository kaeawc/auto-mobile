# Prototype spec: device status, connectivity and window controls

Part of [the agent-authored prototype specification](prototype-ux.md).

**Device status (#14316).** Three state-only modules expose read-only device status under
`/platform/<module>/<key>`; a spec lists the module in `requires.platform` and reads keys with the
`{platform}` forms. Each module has a `<module>.changed` event whose `{event}` data carries the new
values, delivered like `connectivity.changed`. The state updates at once, and the event fires once
the state has been quiet for 500 ms. A flap that settles back on the last delivered values is not an
event. Unknown keys and events fail validation with a
path. No production runtime advertises them yet: the Android and iOS readers are #14322 and #14323.

The host mirrors each delivered `<module>.changed` as `platformStatus.<module>` in `prototype status`
and `inspect`: `values`, the event's device `timestamp`, the host `receivedAt`, and `simulated` for an
injected event. An agent can then assert the device's last values without observing. A replayed event
older than the mirrored reading on the device clock does not replace it. Data with a key or value outside the module's
state table, or cut by the emit budget, is not mirrored and leaves the previous reading.

| Module (capability)                         | Keys                                                                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `battery` (`prototype_platform_battery_v1`) | `level` 0-100, absent when unknown; `state` `charging`, `full`, `unplugged` or `unknown`                                                                                              |
| `power` (`prototype_platform_power_v1`)     | `saver` boolean; `thermal` `nominal`, `fair`, `serious` or `critical`                                                                                                                 |
| `audio` (`prototype_platform_audio_v1`)     | `volume` 0-100 (media stream); `muted` boolean; `route` `speaker`, `wired`, `bluetooth`, `usb`, `airplay`, `cast` or `other`; `ringer` `normal`, `vibrate` or `silent` (Android only) |

**Connectivity (#14273).** The `connectivity` module (`prototype_platform_connectivity_v1`) follows the
same shape:

- `/platform/connectivity/online`, `metered` and `constrained` are booleans.
- `transport` is `wifi`, `cellular`, `ethernet`, `vpn`, `other` or `none`.
- `constrained` is iOS Low Data Mode or Android Data Saver.
- `connectivity.changed` is debounced to one delivery per 500 ms.

CtrlProxy registers the Android runtime and advertises the capability; the embedded renderer leaves the
module to its host app. It reads the default network with `registerDefaultNetworkCallback`, registered on
the first state read so an idle overlay holds no callback, and needs only `ACCESS_NETWORK_STATE`. The
runtime seeds the state from the active network before the callback registers. So the callback's first
delivery is not a transition, and a prototype does not see `connectivity.changed` just for starting.
On Android:

- `online` is `NET_CAPABILITY_VALIDATED`, so a captive or unvalidated Wi-Fi is `online: false` with
  `transport: "wifi"`.
- With no default network the state is offline on `none` with `metered` and `constrained` false.
- `transport` takes the first of `vpn`, `wifi`, `cellular`, `ethernet` that the network carries, so a
  VPN reports `vpn` over its underlying transport. Anything else is `other`.
- `metered` is the absence of `NET_CAPABILITY_NOT_METERED`.
- `constrained` is Data Saver on (`getRestrictBackgroundStatus` not `DISABLED`) on a metered network,
  because Data Saver restricts only metered networks.

State updates at once; the event fires once the state has been quiet for the
debounce, and a flap that settles back on the last delivered state is not an event.

On iOS the agent and Viewer registries run `NWPathMonitor` (no entitlement), started on the module's
first read:

- `online` is a satisfied path with an interface.
- `transport` is the first of Wi-Fi, cellular and wired Ethernet the path uses (a VPN's utun reports
  `other`).
- `metered` is `isExpensive` and `constrained` is Low Data Mode.

The first path after start is the baseline, not a change. Every path that changes the state refreshes
`/platform` at once through a state-only refresh signal the driver applies without running a handler.
So a prototype shown before the first path still sees it; only `connectivity.changed` waits for the
debounce. The offline simulation override is not built.

The reading mappings are normative. `prototypeDeviceStatusReference.ts` is the reference the device status
runtimes copy, replayed from `test/fixtures/prototype-device-status/`:

- Thermal: Android `PowerManager.THERMAL_STATUS_*` 0 is `nominal`, 1-2 `fair`, 3 `serious` and 4-6
  `critical`; iOS `ProcessInfo.ThermalState` maps one to one.
- Battery `state`: Android `BATTERY_STATUS_CHARGING` is `charging`, `FULL` is `full`, `DISCHARGING` and
  `NOT_CHARGING` are `unplugged`, anything else `unknown`; iOS `UIDevice.BatteryState` maps one to one.
- Battery `level` and audio `volume` are whole percents (Android level over scale and stream index over
  its maximum; iOS `batteryLevel` and `outputVolume`). An unknown reading, such as the Simulator's
  battery level of -1, leaves the key absent.
- `ringer` is Android `AudioManager.RINGER_MODE_*`: silent, vibrate or normal.

**Biometric prompt (#14328).** The `biometric` module (`prototype_platform_biometric_v1`) has one call,
`biometric.authenticate` with `title` (required, 1-64 characters), `subtitle` (optional, 1-128) and
`allowDeviceCredential` (optional boolean), and one event, `biometric.attemptFailed`, for a rejected
attempt while the prompt stays up. It has no `/platform` state and needs no declared permission. The
call proves presence only and returns no biometric data. Failures use the typed codes: `cancelled`, and
`unavailable` for a locked-out, unenrolled or hardware-less device. No production runtime advertises the
module yet.

**Window controls (#14320).** Four optional root `window` fields need
`prototype_platform_window_controls_v1`. They are not a platform module, so they need no
`requires.platform` entry:

- `keepScreenOn` (boolean) keeps the screen awake.
- `brightness` (whole 0-100, or `system`) sets the prototype window's brightness.
- `orientation` (`portrait`, `landscape` or `unlocked`) requests an orientation.
- `statusBar` (`light`, `dark` or `auto`) picks the status bar content style.

Each applies only while the prototype is shown and is restored on dismiss; none writes a system
setting. Two controls are best effort: `orientation` over an overlay, and `statusBar` where the
runtime does not own the status bar (an Android overlay, the injected iOS agent). The iOS Simulator
ignores `brightness`.

CtrlProxy advertises the capability and applies
`FLAG_KEEP_SCREEN_ON`, window-local `screenBrightness` (`system` uses `BRIGHTNESS_OVERRIDE_NONE`) and
`screenOrientation`; `unlocked` and omission use `SCREEN_ORIENTATION_UNSPECIFIED`. Replacement rebuilds
these values from the new spec; removal releases them, and an animated exit resets them before waiting
for removal. Failed replacements restore the previous params. Inspect entries add `orientation` for the
requested orientation and `statusBar: "unsupported"` for an authored status bar style. Hierarchy window
entries add the same values as `prototypeOrientation` and `prototypeStatusBar`; omitted controls omit
these fields. Orientation reports a request, not proof that the device rotated. Embedded Android does
not advertise these overlay controls.

**Prototype layout direction.** Optional `window.layoutDirection: "ltr" | "rtl"` requires
`prototype_layout_direction_v1`. Omission inherits the host direction. The iOS renderer overrides
SwiftUI layout direction and root UIKit semantics for the prototype only, without changing locale.
Android does not advertise this capability, so the host refuses specs that set it before showing them.

**Keyboard dismiss (#14320).** The `{type: "hideKeyboard"}` action, which takes no fields, needs
`prototype_hide_keyboard_v1`. It is a plain UI action like `dismiss`, not a platform module, and touches only the
prototype's own window: it hides the soft keyboard and clears text focus (Android `WindowInsetsControllerCompat`
`hide(ime())`; iOS `endEditing(true)`). CtrlProxy advertises the capability and dispatches the action to
the owning surface's host on main, hiding the IME before clearing its view focus. Without a shown
window it does nothing; navigation focusability is retained. The embedded Android renderer does not
advertise it.

**Settings deep links (#14320).** The `settings` module (`prototype_platform_settings_v1`) has one call,
`settings.open` with `page` one of `app`, `notifications`, `location`, `wifi`, `bluetooth` or `display`. The
list is closed and the target package is always the prototype's own runtime package; a spec cannot name
another. The module has no events or `/platform` state. Pages other than `app` and `notifications` are
Android only.

The spec validators are platform-neutral, so the host's iOS show preflight refuses a literal
Android-only `page` with the action's path; a bound page is left to the runtime. The Kotlin validator
needs no such check because it runs only on Android. The Swift agent validator has none yet because
the iOS agent does not advertise the module, which the host's capability gate refuses.

CtrlProxy registers the module on Android and opens each page for its own package with
`FLAG_ACTIVITY_NEW_TASK`. Below API 26 `notifications` opens the app details page, and below API 29 `wifi` opens
the full Wi-Fi screen instead of the panel; both report `outcome: "fallback"`. The result is `{outcome, page,
handler?}`, and no resolving Settings activity is the typed error `unavailable`. The embedded renderer and iOS do
not advertise it yet.

**Contact and calendar pickers (#14318).** Two modules reach the system pickers, which return only what the
user picks and need no declared permission:

- `contacts` (`prototype_platform_contacts_v1`) has `contacts.pick` with an optional `fields` list (one
  to three unique values of `name`, `phone`, `email`) and an optional `multiple` boolean. It is
  `sensitive` because the result is personal data.
- `calendar` (`prototype_platform_calendar_v1`) has `calendar.insert` with `title` (required, 1-256
  characters), `start` and `end` (required, whole milliseconds since the epoch), `allDay`, `location`
  (1-256) and `notes` (1-2048).

Neither module has events or `/platform` state, and a back-out is the typed error
`cancelled`.
No production runtime advertises either module yet.
