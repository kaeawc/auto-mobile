# Physical panel identity: hidden-API finding and fingerprint decision

- Kind: decision
- Date: 2026-10-14
- Source: moved from `how-it-works/plat/android/physical-panel-identity.md`; #12233, #12208, #12220, #12290
- Shaped: [Android physical panel identity](../how-it-works/plat/android/physical-panel-identity.md)

## Context

### The reflection never worked on API 29 and newer

CtrlProxy reflected the hidden `Display.getUniqueId()`. The published hidden-API lists
(`dl.google.com/developers/android/<release>/non-sdk/hiddenapi-flags.csv`) show the
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

It has always been `@hide`, and has also been `@TestApi` since Android 14
(`frameworks/base/core/java/android/view/Display.java`), and it never carried
`@UnsupportedAppUsage` or a `max-target-*` flag. CtrlProxy's `targetSdk` (37) therefore does not
decide anything: lowering it would not unblock the call. The API 36 denial reported in #12208 is
the same denial every API 29+ device produces; only API 24-28 can ever have returned a value
(API 28 was not checked). On every modern device the host fallback has been the only source of
the panel id, and pushed display transitions have never carried a panel key.

## Options

"Distinguishes" means inner versus cover behind the same logical display id.

| Candidate                                                 | Works from             | Distinguishes inner/cover                                                                                                                   | Covers pushed transitions |
| --------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `Display.getUniqueId()` reflection                        | API 24-28 only         | yes, where it works                                                                                                                         | yes, where it works       |
| `Display.getMode().getPhysicalWidth/Height()` + inventory | API 23, public         | yes when native sizes differ; no for identical panels                                                                                       | yes                       |
| `Display.getDeviceProductInfo()` + inventory              | API 31, public         | emulator yes (`EMU_display_0` / `_1`); hardware unknown (internal panels may lack or share an EDID)                                         | yes                       |
| `Display.getName()`                                       | API 17                 | no: both are `Built-in Screen` in captured API 36 dumps                                                                                     | no                        |
| `getDisplayId()`, `DisplayManager` listeners/categories   | public                 | no: logical ids only; `DISPLAY_CATEGORY_REAR` and `ALL_INCLUDING_DISABLED` are `@TestApi`, `BUILT_IN_DISPLAYS` blocked at 36                | signals change, not panel |
| Cutout, rounded corners, `getShape()`, density            | API 28-34              | probably, but adds nothing over native size and needs new inventory parsing                                                                 | yes                       |
| `WindowManager` / `WindowMetrics`                         | API 30                 | only via bounds, which follow rotation, `wm size` and windowing mode                                                                        | yes                       |
| `DeviceStateManager` callback (reflection, already used)  | API 31 (system API)    | indirectly: state id mapped to posture; rear-display and overrides break state-to-panel inference                                           | yes (`device_state`)      |
| `DeviceState.hasProperty(..._OUTER/_INNER_PRIMARY)`       | API 35 (system API)    | default display only, by role not id                                                                                                        | yes                       |
| androidx.window `FoldingFeature` / `WindowAreaController` | library                | no identity: fold feature is absent on cover and non-folding inner states alike; new dependency                                             | no                        |
| `AccessibilityWindowInfo.getDisplayId()`                  | API 30                 | no: logical ids only                                                                                                                        | no                        |
| Display topology (`getDisplayTopology`)                   | API 36, hidden         | not available to an app (`MANAGE_DISPLAYS`, blocked)                                                                                        | -                         |
| Host `cmd display get-displays`                           | API 33 (categories 34) | yes, authoritative; one adb round trip                                                                                                      | only by re-reading        |
| Host `dumpsys display`                                    | all                    | yes, authoritative, both panels; large dump, format differs by level (`mPrimaryDisplayDevice=<name>(<uniqueId>)` on 36, name only on 34-35) | only by re-reading        |
| Host `dumpsys SurfaceFlinger --display-id`                | all checked            | lists physical ids, ports, EDID names, not which is active                                                                                  | no                        |
| Host `cmd device_state print-state`                       | API 33 (`state` 31)    | posture inference only                                                                                                                      | no (already pushed)       |

Other reachable-but-useless members at API 36: `Display.getType()` is `test-api,unsupported` and
returns `TYPE_INTERNAL` for both panels; `Display.getAddress()`, `DisplayAddress.Physical`,
`DisplayInfo.address` and `DisplayInfo.deviceProductInfo` are `blocked`; `DisplayInfo.uniqueId` is
`max-target-o`. The public `Display.toString()` embeds `DisplayInfo.toString()`, which printed the
unique id in Android 10. Since Android 12 it returns before `type`, `uniqueId` and `address` unless
the caller is `system_server` (`if (Process.myUid() != Process.SYSTEM_UID)`,
`frameworks/base/core/java/android/view/DisplayInfo.java`, line 755 in android-12.0.0_r1 and line
999 in android-16.0.0_r1). That is not a source either.

### Rejected alternatives

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

## Decision

No supported device-side API returns the physical display id, and none is coming in the API 36 SDK,
so the id stays a host-side fact. CtrlProxy sends a native-size `panelFingerprint` that the host joins
to its inventory; `cmd display get-displays` stays the authority.

## Consequences

This gives pushed transitions a panel key, lets no-probe callers resolve a panel, and removes the
window in which a stale logical-id map is trusted after a swap. It is exactly as discriminating as
the inventory's own role assignment, which is also by size: wherever the host can say "inner" and
"cover", the fingerprint resolves.

If device captures show `DeviceProductInfo` is populated and distinct on hardware, the fingerprint
and the inventory parser could add its name, PnP id and product id. That would close two of the
page's known limits: same-size panels, and an external display with a built-in panel's native size.
The inventory parser already sees the same `deviceProductInfo` text in `dumpsys display`.
The fingerprint deliberately leaves it out for now: it changes the published `displays.panels` shape
and rests on a field whose contents on real foldables nobody has verified.

### Device checks owed

Device testing was paused when this was written (#12220). Nothing here is device-verified. On an
API 36 Pixel Fold AVD (two real panels) and one API 34 or 35 foldable AVD:

1. Folded and unfolded, compare the `panelFingerprint` in a hierarchy result with the
   `DisplayDeviceInfo` size of the panel that `cmd display get-displays` reports for logical
   display 0. They must be equal, in natural orientation, in both postures and after a rotation.
2. Fold and unfold: the pushed `display_transition` for display 0 carries the new panel's
   fingerprint. The host's transition tracker reports the new panel key without an adb call, and
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
