# Android physical panel identity

On a foldable, logical display 0 moves between the inner and the cover panel, and the other panel
gets a new logical id on every swap. AutoMobile therefore keys a panel by its physical display id
(the digits of `local:<id>`), which is also the id `screencap -d` and `screenrecord --display-id`
take.

The id is a host-side fact. CtrlProxy cannot read it on API 29 and newer: the hidden
`Display.getUniqueId()` is blocked for apps there, whatever CtrlProxy's `targetSdk`, so only API 24-28
devices can send a real `panelUniqueId`. No supported device-side API returns the physical display
id.

## Host panel inventory

- Discovery builds the panel inventory once from `dumpsys SurfaceFlinger --display-id`,
  `dumpsys display` (`DisplayDeviceInfo{... uniqueId="local:N", W x H ...}` records, one per
  physical panel whether or not it is active) and `cmd device_state print-states`. Roles come from
  pixel area: the largest internal panel is `inner`, the smallest is `cover`. When there are two
  or more internal panels and no fold posture, `ro.build.characteristics` is read once. On an
  `automotive` build, the first largest internal panel is the center display under role `unknown`
  (the non-foldable role a phone's built-in panel has; `inner` and `cover` are fold panels), every
  other internal panel is `cluster` (the instrument cluster), and the inventory reports no
  postures, so no message offers `setPosture` on a car. The cluster app's own virtual display
  (`ClusterOsDouble-VD`) is reported under role `virtual`, as for any other app-created display.
  A failed inventory read is retained as an unreadable outcome: explicit display keys, roles and
  aggregate observations fail with retryable `DisplayInventoryUnavailableError` rather than treating
  a fallback panel as a successful inventory. Unknown-key errors list real panels only after a
  successful read; omitted and `active` selectors retain their default routing. A `pressButton`
  whose `active` falls back to logical display 0 sends `input -d 0` and keeps its observations
  unscoped, since the fallback key is not a selector the caller chose. Display-targeted gestures
  (tapAt, dragPath, swipes, drags, hover, element taps) likewise pass `active`, not the fallback
  key, to their follow-up reads and to the shared navigation settle polls; it re-resolves to the
  same sole fallback panel.
- Overlay displays (`overlay_display_devices`, `type OVERLAY`, `uniqueId="overlay:N"`) have no
  SurfaceFlinger physical id, so they join the inventory after the physical panels under role
  `overlay` with the whole `overlay:N` as key: a bare `N` could be mistaken for a logical display
  id. They are addressable by key or role, but are not panels: `display: "all"`, posture
  defaults, the inventory-order fallback and `requires.panels` skip them, and `screencap -d`
  cannot capture them.
- App-created virtual displays (`DisplayManager.createVirtualDisplay`, `type VIRTUAL`) join after
  the overlays under role `virtual`, with the same non-panel rules. DisplayManager writes
  `virtual:<package>,<uid>,<name>,<index>`; the key keeps only `virtual:<package>:<name>`
  because uid and index change across reinstalls and recreations (an app-supplied
  `virtual:<package>:<id>` is kept whole). Displays owned by `com.android.shell` or an AutoMobile
  package are left out: the video server runs as shell and creates one per recording, which
  would otherwise change the inventory, and every inventory-keyed cache, on each recording start
  and stop. A key two live displays share is left out too, since it cannot target either.
- Per observation, `ObservedAndroidDisplayCache` maps a logical display id to a panel with
  `cmd display get-displays` (one `Display id N: DisplayInfo{... uniqueId "local:N" ...}` line per
  shell-visible logical display), cached for 5 seconds and cleared by a display transition.
  When a virtual, overlay or cluster inventory panel is missing, observation and action connection
  checks supplement the list from enabled records in `dumpsys display`'s Logical Displays section.
  Only missing secondary inventory panels and unreported nonzero logical ids are added; the shell
  list wins conflicts, and disabled fold panels remain disconnected. Physical-only inventories
  need no additional read.
- Addressing a display and reading its hierarchy are separate. The key resolves to a logical id
  from the display service alone (`cmd display get-displays`, then `dumpsys display`), never from
  accessibility windows, so a display accessibility cannot see still resolves and still takes
  `input -d <logicalId>`. Accessibility does not track private virtual displays (`type VIRTUAL`
  with `FLAG_PRIVATE`, such as Android Auto's car displays or a private emulator
  `-multidisplay` display). When CtrlProxy refuses a selected display, the UIAutomator fallback
  first reads that display's `dumpsys display` record: for a private virtual display it raises
  `UntrackedAndroidDisplayError` (non-retryable) without dumping, because `uiautomator dump
  --display` there returns the default display's content. Otherwise the dump must prove it came
  from that display, because some releases ignore `--display`: every node fits the display's
  current size (the `mOverrideDisplayInfo` record, rotated like window bounds), one top-level
  window spans it exactly, and the display differs in size from display 0. A display the size of
  display 0 cannot be read this way.
- A pushed `display_transition` without a panel key clears that cache; the next observation
  re-reads it, but callers that may not probe (`tapOn` refresh) get no panel, and the transition
  tracker cannot tell a panel swap from a same-panel change except by width and height.

## Panel fingerprint

The device supplies, cheaply and through public API only, enough physical evidence for the host to
pick the right inventory panel without another adb round trip:

1. **CtrlProxy sends a panel fingerprint.** Every hierarchy result and every pushed
   `display_transition` carries an additive `panelFingerprint: {width, height}`, read from
   `Display.getMode().getPhysicalWidth()/getPhysicalHeight()`. This is the native size of the
   panel currently behind that logical display. It does not rotate and ignores `wm size`
   overrides. `LogicalDisplay` copies the mode list from the primary display device, so it changes
   in the same update as the unique id would.
2. **The host joins the fingerprint to its inventory.** A fingerprint resolves to a panel only when
   exactly one inventory panel has that exact native size. A real `panelUniqueId` (API 24-28)
   still wins. With no fingerprint, no inventory, or an ambiguous match, the host uses the cached
   logical-id map, then `cmd display get-displays`. Hierarchy results are matched
   against the calling tool's hydrated inventory; pushed transitions are matched against the
   display inventory provider's settled cache, read before the push invalidates it, with no adb
   call. A `device_state` push never yields a key from its fingerprint, because it can arrive
   before the display swap and still describe the old panel. A resolved key is not compared with
   a previous placeholder key (`"0"`), so a rotation-only push stays a non-transition.
3. **`cmd display get-displays` stays the authority** for ambiguous devices, for selecting a panel
   to act on (`logicalIdForPanel`) and for the `screencap -d` id. A logical display it does not
   list (a `FLAG_PRIVATE` AAOS cluster panel) takes its `screencap -d` id from the `local:`
   uniqueId of its enabled record in `dumpsys display`'s Logical Displays section; a display
   absent from both, or listed without a `local:` id, is not captured. Where `cmd display` has no
   `get-displays` subcommand (API 30 answers `Unknown command`), the enabled records of that
   Logical Displays section replace it; a record with no `mIsEnabled` line (that field is absent
   on API 30) counts as enabled. When neither source can be read, the selection fails with a
   non-retryable error, since a retry would fail the same way.

The fingerprint is internal evidence: it is stripped from observe output, and it is not sent per
window, per node or on screenshot frames.

Known limits, all of which fall back to the host probe rather than guess:

- Two panels with the same native size (dual-screen devices) are ambiguous.
- A device that changes its active resolution after discovery no longer matches until the
  inventory is re-read.
- A panel missing from a stale inventory cannot be matched; if an external display with a built-in
  panel's exact native size is attached after discovery it could be mistaken for that panel until
  the inventory refreshes (an `added` push already invalidates it).

## Background

- [Physical panel identity: hidden-API finding and fingerprint decision](../../../devlog/2026-10-14-physical-panel-identity-fingerprint.md)
