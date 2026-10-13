# Android physical panel identity

On a foldable, logical display 0 moves between the inner and the cover panel, and the other
panel gets a new logical id on every swap. AutoMobile therefore keys a panel by its physical
display id (the digits of `local:<id>`), which is also the id `screencap -d` and
`screenrecord --display-id` take. This document records how that id can be obtained, what was
ruled out, and what still has to be confirmed on a device (#12233, #12208).

## Finding: the reflection never worked on API 29 and newer

CtrlProxy reflected the hidden `Display.getUniqueId()`. The published hidden-API lists
(`https://dl.google.com/developers/android/<release>/non-sdk/hiddenapi-flags.csv`) show the
method was never reachable by an ordinary app once enforcement existed:

| Release | API | Flag for `Landroid/view/Display;->getUniqueId()` |
| ------- | --- | ------------------------------------------------ |
| qt      | 29  | `blacklist`                                      |
| rvc     | 30  | `blacklist`                                      |
| sc      | 31  | `blocked`                                        |
| tm      | 33  | `blocked`                                        |
| udc     | 34  | `blocked,test-api`                               |
| vic     | 35  | `blocked,test-api`                               |
| baklava | 36  | `blocked,test-api`                               |

It is `@hide` in Android 10 through 13 and `@hide @TestApi` from Android 14
(`frameworks/base/core/java/android/view/Display.java`), and it never carried
`@UnsupportedAppUsage` or a `max-target-*` flag. CtrlProxy's `targetSdk` (36) therefore does not
decide anything: lowering it would not unblock the call. The API 36 denial reported in #12208 is
the same denial every API 29+ device produces; only API 24-28 can ever have returned a value
(API 28 was not checked). On every modern device the host fallback has been the only source of
the panel id, and pushed display transitions have never carried a panel key.

## What the host does today

- Discovery builds the panel inventory once from `dumpsys SurfaceFlinger --display-id`,
  `dumpsys display` (`DisplayDeviceInfo{... uniqueId="local:N", W x H ...}` records, one per
  physical panel whether or not it is active) and `cmd device_state print-states`. Roles come from
  pixel area: the largest internal panel is `inner`, the smallest is `cover`.
- Per observation, `ObservedAndroidDisplayCache` maps a logical display id to a panel with
  `cmd display get-displays` (one `Display id N: DisplayInfo{... uniqueId "local:N" ...}` line per
  active logical display), cached for 5 seconds and cleared by a display transition.
- A pushed `display_transition` without a panel key clears that cache; the next observation
  re-reads it, but callers that may not probe (`tapOn` refresh) get no panel, and the transition
  tracker cannot tell a panel swap from a same-panel change except by width and height.

## Candidates

"Distinguishes" means inner versus cover while both sit behind the same logical display id.

| Candidate                                                                    | Works from                                 | Needs                                                                | Cost per capture             | Distinguishes inner/cover                                                                                                     | Covers pushed transitions                             |
| ---------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `Display.getUniqueId()` reflection                                           | API 24-28 only                             | nothing                                                              | none                         | yes, where it works                                                                                                           | yes, where it works                                   |
| `Display.getMode().getPhysicalWidth/Height()` joined to the inventory        | API 23, public                             | host inventory with both panels                                      | none (in-process read)       | yes when the panels' native sizes differ; no for identical panels                                                             | yes                                                   |
| `Display.getDeviceProductInfo()` joined to the inventory                     | API 31, public                             | host inventory that keeps product info; an EDID on the panel         | none                         | on the emulator yes (`EMU_display_0` / `EMU_display_1`); on hardware unknown, internal panels may have no EDID or share one   | yes                                                   |
| `Display.getName()`                                                          | API 17, public                             | nothing                                                              | none                         | no: both panels are `Built-in Screen` in the captured API 36 dumps                                                            | no                                                    |
| `Display.getDisplayId()`, `DisplayManager` listeners and categories          | public                                     | nothing                                                              | none                         | no: logical ids only. `DISPLAY_CATEGORY_REAR` and `ALL_INCLUDING_DISABLED` are `@TestApi`, `BUILT_IN_DISPLAYS` is blocked at 36 | signals a change, not the panel                       |
| Cutout, rounded corners, `getShape()`, density                               | API 28-34, public                          | host inventory with the same fingerprints (it has none)              | none                         | probably, but adds nothing over native size and needs new inventory parsing                                                   | yes                                                   |
| `WindowManager` / `WindowMetrics`                                            | API 30, public                             | nothing                                                              | none                         | only through bounds, which follow rotation, `wm size` overrides and windowing mode                                            | yes                                                   |
| `DeviceStateManager` callback (already used via reflection)                  | API 31 (`sdk,system-api` on the lists)     | not in the public `android.jar`; reflection of a system API          | none                         | indirectly: a state id, which the host maps to a posture; rear-display and overrides break the state-to-panel inference       | yes (already pushed as `device_state`)                |
| `DeviceState.hasProperty(..._OUTER_PRIMARY / _INNER_PRIMARY)`                | API 35 (`sdk,system-api`)                  | reflection of a system API                                           | none                         | yes for the default display only, by role rather than id                                                                      | yes                                                   |
| androidx.window `FoldingFeature` / `WindowAreaController`                    | library; non-Activity UI context since 1.1 | new dependency; OEM extensions present                               | listener                     | no identity: a fold feature is absent on the cover panel and on non-folding inner states alike                                | no                                                    |
| Accessibility surfaces (`AccessibilityWindowInfo.getDisplayId()`)            | API 30, public                             | nothing                                                              | none                         | no: logical ids only. `AccessibilityDisplayProxy` is `@SystemApi`                                                             | no                                                    |
| Display topology (`getDisplayTopology`, `registerTopologyListener`)          | API 36, hidden                             | `MANAGE_DISPLAYS`; blocked on the lists                              | -                            | not available to an app                                                                                                       | -                                                     |
| Host `cmd display get-displays`                                              | API 33 (categories from 34)                | shell uid                                                            | one adb round trip           | yes, authoritative                                                                                                            | only by re-reading after a push                       |
| Host `dumpsys display`                                                       | all                                        | shell uid; a large dump (hundreds of lines; format differs by level) | one adb round trip, large    | yes, authoritative, both panels at once (`mPrimaryDisplayDevice=<name>(<uniqueId>)` on API 36, name only on 34-35)            | only by re-reading after a push                       |
| Host `dumpsys SurfaceFlinger --display-id`                                   | all checked                                | shell uid                                                            | one adb round trip           | lists physical ids, ports and EDID names, not which one is active                                                             | no                                                    |
| Host `cmd device_state print-state`                                          | API 33 (`state` from 31)                   | shell uid                                                            | one adb round trip           | by posture inference only                                                                                                     | no (the device already pushes the state)              |

Other reachable-but-useless members at API 36: `Display.getType()` is `test-api,unsupported` and
returns `TYPE_INTERNAL` for both panels; `Display.getAddress()`, `DisplayAddress.Physical`,
`DisplayInfo.address` and `DisplayInfo.deviceProductInfo` are `blocked`; `DisplayInfo.uniqueId` is
`max-target-o`; and `DisplayInfo.toString()` omits the unique id outside `system_server`.

## Recommendation

No supported device-side API returns the physical display id, and none is coming in the API 36
SDK. The id has to stay a host-side fact. What the device can supply, cheaply and through public
API only, is enough physical evidence for the host to pick the right inventory panel without
another adb round trip:

1. **CtrlProxy sends a panel fingerprint.** Every hierarchy result and every pushed
   `display_transition` carries an additive `panelFingerprint: {width, height}`, read from
   `Display.getMode().getPhysicalWidth()/getPhysicalHeight()`. This is the native size of the
   panel currently behind that logical display. It does not rotate and ignores `wm size`
   overrides. `LogicalDisplay` copies the mode list from the primary display device, so it changes
   in the same update as the unique id would.
2. **The host joins the fingerprint to its inventory.** A fingerprint resolves to a panel only when
   exactly one inventory panel has that exact native size. A real `panelUniqueId` (API 24-28)
   still wins. With no fingerprint, no inventory, or an ambiguous match, behaviour is what it was:
   the cached logical-id map, then `cmd display get-displays`.
3. **`cmd display get-displays` stays the authority** for ambiguous devices, for selecting a panel
   to act on (`logicalIdForPanel`) and for the `screencap -d` id.

This gives pushed transitions a panel key, lets no-probe callers resolve a panel, and removes the
window in which a stale logical-id map is trusted after a swap. It is exactly as discriminating as
the inventory's own role assignment, which is also by size: wherever the host can say "inner" and
"cover", the fingerprint resolves.

Known limits, all of which fall back to the host probe rather than guess:

- Two panels with the same native size (dual-screen devices) are ambiguous.
- A device that changes its active resolution after discovery no longer matches until the
  inventory is re-read.
- A panel missing from a stale inventory cannot be matched; if an external display with a built-in
  panel's exact native size is attached after discovery it could be mistaken for that panel until
  the inventory refreshes (an `added` push already invalidates it).

If device captures show `DeviceProductInfo` is populated and distinct on hardware, adding its
name, PnP id and product id to the fingerprint (and to the inventory parser, which already sees
the same `deviceProductInfo` text in `dumpsys display`) would close the first and third limits.
That is deliberately not built yet: it changes the published `displays.panels` shape and rests on
a field whose contents on real foldables are unverified.

## Rejected alternatives

- **`settings put global hidden_api_policy 1`** (and the `hidden_api_policy_p_apps` /
  `pre_p_apps` / `hidden_api_blacklist_exemptions` settings): disables or weakens hidden-API
  enforcement for every app on the device. It changes device-global state that outlives the
  session and changes how the apps under test behave. Needs an explicit owner decision; not used.
- **Meta-reflection or `VMRuntime.setHiddenApiExemptions`-style bypass libraries**: defeat platform
  enforcement from inside the app, depend on runtime internals that ART has been closing
  (`kPreventMetaReflectionBlocklistAccess`), and put the accessibility service at risk on every
  platform update. Not used.
- **`am compat enable ALLOW_TEST_API_ACCESS <package>`**: per-package rather than global, but only
  honoured for debuggable builds, so it cannot work for the release CtrlProxy APK. Not used.
- **A shell-uid helper started with `app_process`**: would run arbitrary code as shell to call the
  hidden API. Unnecessary, because the shell commands above already print the same id.
- **Lowering `targetSdk`**: has no effect; the method is not on a `max-target-*` list.
- **Reaching `DisplayInfo.uniqueId` through `Display.mDisplayInfo`**: the field is `max-target-o`,
  so it is blocked for any current target.
- **Inferring the panel from device state alone**: wrong in rear-display mode and under state
  overrides, and says nothing about secondary displays.
- **androidx.window**: a new dependency that reports fold geometry, not panel identity.

## Device checks owed

Device testing was paused when this was written (#12220). Nothing here is device-verified. On an
API 36 Pixel Fold AVD (two real panels) and one API 34 or 35 foldable AVD:

1. Folded and unfolded, compare the `panelFingerprint` in a hierarchy result with the
   `DisplayDeviceInfo` size of the panel that `cmd display get-displays` reports for logical
   display 0. They must be equal, in natural orientation, in both postures and after a rotation.
2. Fold and unfold: the pushed `display_transition` for display 0 carries the new panel's
   fingerprint, the host's transition tracker reports the new panel key without an adb call, and
   the first observation after the swap names the same panel as `get-displays`.
3. `wm size 1080x1920` then observe: the fingerprint is unchanged.
4. Rear-display mode and a state override (`cmd device_state state <id>`): the fingerprint follows
   the real panel.
5. Logcat for the CtrlProxy pid shows no `hiddenapi` line from the fingerprint read, and exactly
   one debug line for the unavailable `getUniqueId`.
6. A dual-display AVD with an external display: the secondary display's fingerprint resolves to
   its own panel or to none, never to a built-in panel.
7. Capture `Display.getDeviceProductInfo()` for both panels on real foldable hardware (name, PnP
   id, product id) to decide whether product info should join the fingerprint.
8. An API 28 or older device, if one is available: `panelUniqueId` is still sent and still wins.
9. A single-panel phone on an older API: no behaviour change.
