# Manufacturer profiles

The `manufacturerProfile` tool approximates an OEM device on a stock Android emulator
or device. A manufacturer profile is a named, versioned bundle of facets. Each facet is applied by an existing tool:

| Facet      | Applied with            | What it changes                                               |
| ---------- | ----------------------- | ------------------------------------------------------------- |
| `keyboard` | `keyboard` `setProfile` | The AutoMobile IME's typing behaviour (`gboard`, `samsung`)   |
| `kill`     | `killProfile`           | Standby bucket, appops, Doze and force-stop for one package   |
| `display`  | `displayProfile`        | Display cutout and navigation-mode overlays, density and more |

## Manufacturer profiles simulate effects, not firmware

A manufacturer profile reproduces what an app **observes** on an OEM's devices: its process killed in the
background, a punch-hole cutout, three-button navigation, a different typing behaviour. It does
not install or imitate the OEM's firmware. One UI, HyperOS, OxygenOS and ColorOS SystemUI,
vendor services and the triggers that decide when an OEM restricts an app are not present, so a
passing test under a manufacturer profile is evidence about the app's handling of those effects, not about
behaviour on the real device.

Every facet carries its evidence:

- `focused_trace`: matches traces captured from the real component.
- `vendor_documented`: the OEM or Android documents the behaviour.
- `cdd_derived`: follows from the Android Compatibility Definition Document.
- `inferred`: approximated from community reports or common hardware.
- `experimental`: an AutoMobile model not yet checked against the real component.

`manufacturerProfile` `describe` reports the status, note and source of each facet of a
manufacturer profile.

## Starter catalog

| Profile            | Keyboard  | Kill profile                | Display                       |
| ------------------ | --------- | --------------------------- | ----------------------------- |
| `pixel-baseline`   | `gboard`  | none                        | none                          |
| `samsung-oneui`    | `samsung` | `samsung-sleeping`          | hole cutout, three-button nav |
| `xiaomi-hyperos`   | `gboard`  | `xiaomi-autostart-off`      | hole cutout                   |
| `oneplus-oxygenos` | `gboard`  | `oneplus-deep-optimization` | hole cutout                   |
| `oppo-coloros`     | `gboard`  | `recents-swipe-force-stop`  | hole cutout                   |
| `motorola`         | `gboard`  | `motorola-adaptive`         | none                          |

The catalog has a `catalogVersion`, and each manufacturer profile a `version` that changes whenever one of
its facets does, so a result names exactly what it applied.

## Applying, switching and resetting

- `apply` runs the keyboard, kill and display facets in that order. A manufacturer profile
  with a kill profile needs the `appId` it targets.
- Manufacturer profiles replace one another. Applying one other than the one recorded on the device
  first resets the recorded one, so its facets do not linger; the result names it as
  `replaced`.
- `reset` restores the display facets, the kill facet of every package a manufacturer profile
  changed, and the keyboard profile that was active before the first change. The display, kill
  and keyboard records are shared with `displayProfile`, `killProfile` and `keyboard`
  `setProfile`, so reset also undoes their direct changes on the device.
- When the session is released or rebound, the device restores the keyboard, kill and display facets, so the
  device's next session does not inherit them. A facet release already restored is not written
  again by a later `reset`.

## Acquiring a device with a manufacturer profile

`provisionDevice` takes an Android `device.spec.deviceProfile`:

```ts
provisionDevice({
  device: {
    platform: "android",
    name: "phone-api-36",
    spec: {
      runtime: "system-images;android-36;google_apis;x86_64",
      deviceType: "pixel_9",
      deviceProfile: { manufacturerProfile: "samsung-oneui", requires: ["knox"] },
    },
  },
});
```

- It needs `boot: true` and `readiness: "automation"`. It is applied after the automation runner
  is ready, to the session the call returns, and the result reports it as `manufacturerProfile`.
- It is not the AVD hardware profile (`deviceType`) and is never part of the AVD definition, so
  it does not change which device is created or adopted.
- The kill facet needs the app it targets, which acquisition does not know, so it is reported as
  `deferred`. Apply it with `killProfile` once the app is installed.
- When `requires` names a capability the profile cannot emulate, the call fails with
  non-retryable `requires_real_device` and its `capabilities` before anything is created or
  booted.
- Releasing that session restores everything the profile changed, including the keyboard
  profile, so the device's next session starts from baseline.

## What cannot be emulated

Each manufacturer profile lists the OEM capabilities no stock device provides, for example Samsung DeX, Knox,
the Galaxy Z Flip cover screen, S Pen Air actions, the OEM's own SystemUI and Xiaomi's
proprietary AppOps. Pass the capabilities a task needs as `requires`; when the manufacturer
profile cannot emulate one, `apply` returns `status: "route_to_real_device"` and changes nothing, so the task
can be routed to real hardware instead of passing silently.
