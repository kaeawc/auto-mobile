# Android form factors: TV, Wear OS and Android Auto

Form-factor support, navigation contracts and remaining verification gaps.

> [!WARNING]
> **Wear OS remains unverified on emulators.** The TV section is verified on the Android 36 `android-tv` `arm64-v8a` user image and the Automotive OS baseline on the images named in its section below. "Verified in the repo" means read from this checkout; "Hypothesis" means from AOSP and Android documentation.

## Verdicts

| Form factor                                  | Verdict            | Smallest useful tool surface                                                                       | Main risk                                                                        |
| -------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Android TV / Google TV                       | **Go**             | `focusNavigate`, a `select` key on `sendKeys` only if `enter` falls short, TV form-factor matching | Google TV and no-touchscreen devices unverified; child-label `focusNavigate` gap |
| Wear OS                                      | **Conditional go** | rotary scroll, `isScreenRound` in `observe`, ambient toggle                                        | Ambient reads `inAmbient` from `dumpsys wear_service`; hardware wake is untested |
| Android Auto (projection to a DHU)           | **No-go**          | none                                                                                               | The car UI is not in any accessibility tree AutoMobile can read                  |
| Android Automotive OS (an AAOS system image) | **Go**             | existing tools; rotary `pressButton` buttons; `vehicle` `deviceCondition`                          | Play Store `user` images refuse vehicle-motion injection; secondary displays     |

Android Auto projects a phone's UI to a head unit; Automotive OS is a full Android build on the car. Only the latter is feasible.

## What the repo does today (verified)

- **Matching.** The vocabulary is `phone | tablet | foldable | tv | watch | automotive | xr-headset | xr-glasses | unknown` (`src/models/DeviceMatchCriteria.ts`); binding `family` takes the same values except `unknown` (`BINDING_DEVICE_FAMILIES`, `src/utils/provisionDeviceSpecSchemas.ts`). `formFactorFrom` (`src/models/formFactor.ts`) classifies `tv`, `watch` and `automotive` from the system-image tag first (`android-tv`, `android-wear`, `android-automotive`), then the avdmanager profile id, then geometry (fold/flip by profile name; diagonal >= 7in is a tablet, else phone), so a TV is never matched as a tablet. iOS accepts only `phone` and `tablet`. `startDevice` `formFactor`, the broker binding `deviceFamily` and the device description accept the new values; `getAndroid` has no `formFactor` input. `startDevice` with `createIfMissing` creates `tv`, `watch` and `automotive` AVDs. A `watch` request picks only installed `android-wear-signed`, `android-wear` and `android-wear-cn` images (in that order, behind API level and host ABI) and creates the AVD with `wearos_small_round`, or `wearos_square` when `requires.screenRound` is `false`; with no Wear image installed it fails naming the `sdkmanager` command. `requires.screenRound` also restricts matching, stopped or booted, to a Wear profile whose id names that shape (`wearProfileScreenRound`), so a square request never reuses a round watch, and it is refused for creation outside an Android `watch` request. A physical watch has no profile id, so it never satisfies `requires.screenRound`; physical watches stay out of scope. An `automotive` request picks only installed `android-automotive-playstore` / `android-automotive` images (Play first, behind API level and host ABI, with the CtrlProxy minSdk floor), creates the AVD with `automotive_1024p_landscape`, and with no car image installed fails with the exact `sdkmanager` command; a repeated request reuses the AVD because those tags classify it as `automotive`. `requires.vehicle.motion: "supported"` restricts matching and creation to non-Play `android-automotive` images (`isMotionCapableAutomotiveTag`), since Play car images are `user` builds whose car service refuses driving-state injection; a booted automotive device's traits carry `vehicle` derived from `ro.build.type` (then `ro.debuggable`), both `unsupported` unless `ro.kernel.qemu` marks an emulator, read only when `ro.build.characteristics` announces `automotive`, with no probe that changes car state. The tag and profile names are still unconfirmed on real images.
- **Android XR.** `xr-headset` classifies the `google-xr`, `android-xr-v3-playstore` and `android-xr-preview-playstore` tags and `xr_headset*` profiles; `xr-glasses` classifies the `ai-glasses` tag and `xr_glasses_*` / `ai_glasses_*` profiles. A request for either picks only its own images in that order (behind API level and host ABI) and creates the AVD with `xr_headset_device` or `ai_glasses_device` (the profile `avdmanager list device` tags `ai-glasses`); with none installed it fails naming the `sdkmanager` package and `--channel=3`. `requires.playStore` on a headset picks only the Play variants; glasses have no known Play image. Booted-device traits read `xr` (headset) or `glasses` in `ro.build.characteristics`, but the 450×450 ai-glasses emulator reports `nosdcard,watch`, so `glassesInput` also uses profile/runtime form-factor identity and injects DPAD_CENTER for tap, DOWN/UP for vertical forward/back and RIGHT/LEFT for horizontal forward/back without read-back: `touchnavigation` swipes can emit only motion after idle, `touchpad` motion does not move focus, key holds produce no long click, and raw touchpad injection requires adb root and is swallowed by unpaired glasses system UI, leaving long press and two-finger gestures unsupported. Runtime XR behaviour (tapOn and tapAny node clicks, no ghost-tap retry) does not use that form factor: it asks the one shared predicate (`src/utils/android-cmdline-tools/androidXrDevice.ts`), which reads the `android.software.xr.api.spatial` system feature once per device (cached for five minutes), the same signal CtrlProxy uses, and falls back to the `xr-*` form factor only when the probe fails. Headset home-space input uses screenshot pixels for `tapAt`, including normalized, percent and image inputs. Android input and task bounds use display pixels; the API 34 google-xr headset's 2560×2558 display produces a 2558×2558 composed-eye screenshot. At the default pose the panel projection is `shot = (shotWidth/2, 0.552*shotHeight) + (61/64)*(display - taskCentre)`, with task centre derived from its bounds. `tapAt` inverts this projection before dispatch and reports the selected task and display point in `xrPanel`. It refuses points outside the projected panel, including XR system UI. The tool-by-tool result on the headset emulator is in [Android XR headset: tool baseline](xr-headset.md).

  XR detection is one shared predicate (`isAndroidXr`, `src/utils/android-cmdline-tools/androidXrDevice.ts`) for `tapOn`, `tapAny`, `tapAt`, `swipeOn` (screen swipes, the scroll-search screen fallback and the default-pose check) and `sendKeys` routing. It reads the `android.software.xr.api.spatial` system feature (the signal CtrlProxy uses) once per device and caches it for five minutes. Only without a device handle, or when the probe fails, does it fall back, uncached, to the `xr-*` form factor or XR System UI task/activity names in the observation back stack. That back-stack check is private to the predicate; panel geometry only receives the predicate's answer. On XR, `tapOn` and `tapAny` exclude System UI nodes whose extractor `visible-to-user` flag is false from target selection, preferring a visible match and otherwise refusing with guidance to observe the visible control or use screenshot coordinates with `tapAt`. Ownership comes from the node resource ID or its window package name. Unconstrained `tapAny` starts in the captured foreground app window when available; XR candidates prefer the topmost window, then complete sibling rows and top/left/capture order. A leaf container with no clickable descendant uses its nearest clickable owner within three ancestors, stopping before window roots, full-window ancestors, ancestors exceeding 25% of the area of the leaf's owning window root (or viewport area when that root has no bounds), or ancestors containing other tap-actionable descendants outside the leaf-to-owner chain. Hidden nodes do not count as covering application windows for taps or observation occlusion. XR SystemUI home and caption windows are excluded from window covers; same-app and other-app dialogs still cover rows. On the default XR display, observe reconciles hierarchy dimensions with `wm size` (override size first), rotated to match the capture and cached within each ObserveScreen instance by device and rotation parity, because IME process bounds can shrink the reported hierarchy size. `tapOn` and `tapAny` click the accessibility node (or refuse) instead of sending panel-space coordinates, and skip the ghost-tap retry, because an unchanged hierarchy does not prove a node click missed and a second click would toggle a switch back. A node click CtrlProxy received but never answered (its reply outlived the client request timeout, since CtrlProxy replies only after the post-click settle and extraction) is not a refusal: `tapOn` decides it from the post-tap observation, succeeding with a warning when the screen changed and otherwise failing as unconfirmed with guidance to observe before retrying; `tapAny` fails it as unconfirmed. Only an explicit CtrlProxy refusal, or a click that was never sent, returns the panel-coordinate error. The first freeform app task in top-first order supplies the panel bounds; System UI and the environment task are excluded. Screen swipes (including the scroll-search screen fallback) use these display bounds, already below the status bar. A full-display swipe can start below the panel, focus the System UI visibility barrier and dismiss the panel, so missing-panel and edge gestures are refused. This measured projection supports home space at the default headset pose only; it does not infer moved-panel poses or immersive layouts. `observe` node bounds remain in panel-window/display space and are not converted by this mapping. Internal callers that tap a hierarchy element centre (exploration, `setUIState`'s bounds-centre fallback) pass the internal `pointSpace: "native"` option, which skips the panel mapping; the public `tapAt` tool always uses screenshot space. XR glasses are outside this coordinate model.

  On the headset emulator the default keyboard (Gboard) stays the active editor connection and the observed hierarchy has no readable focused field, so on an XR device (the shared predicate above) an Auto `sendKeys` `type` routes to `a11y` when a keyboard other than the AutoMobile IME is shown with no readable focused editable field, and the command's `warning` says so. Phones always keep the AutoMobile IME as the Auto default, even with Gboard shown and no readable focus (a WebView or Compose field).

- **Provisioning.** `provisionDevice` takes `runtime` as a system-image package id; `parseAndroidSystemImageRuntime` accepts any tag between API level and ABI (only `google_apis_playstore` is special-cased). Default creation (`pickAndroidSystemImage`, `src/devices/deviceProvisioning.ts`) picks an image family from the requested form factor (`androidImageFamilyFor`): handheld tags for phone, tablet, foldable or none (#14900), and only the TV tags for `tv`, ranked `android-tv`, `google-tv`, `google-tv-ps16k` behind API level and host ABI. `android-tv` leads because Play Store builds usually refuse `adb root`; this ordering rationale concerns Play Store images only and does not guarantee root on `android-tv`. The verified `android-tv` user build also refuses `adb root`. A TV AVD gets the `tv_1080p` profile. The tag lists and default profiles live once in `src/models/formFactor.ts` and the broker's family defaults read them. With no TV image in range the error names the `sdkmanager` command; nothing is downloaded.
- **CtrlProxy.** `minSdk` 24 (`android/gradle/libs.versions.toml`) is not a blocker. The manifest declares no `<uses-feature>` and only a `LAUNCHER` category (no `LEANBACK_LAUNCHER`). The accessibility config requests window content, interactive windows and gesture dispatch.
- **Input.** `sendKeys` supports arrows (`KEYCODE_DPAD_*`), enter, tab, escape, backspace, delete (`INPUT_KEY_CODE_MAP`, `src/features/action/InputKey.ts`); there is no D-pad centre, menu or media key. `pressButton` sends back/home/recent as global actions with ADB fallback, plus volume/power via ADB.
- **Focus.** `observe` returns `focusedElement` (`ActiveWindowAttribution.ts`, `HierarchyFocus.ts`) from the `focused` property; TalkBack focus is separate (`accessibility-focused`).
- `observe` reports `isScreenRound` and, when identifiable, `surface` only for `watch` devices. `surface` requires an active window and hierarchy: non-Wear-SystemUI apps are `app`, Wear SystemUI's `experiences.globallauncher.*` activities are `launcher`, and its `mainui.activity.SysUiActivity` is `tile` when the hierarchy contains `com.google.android.clockwork.sysui:id/carousel_tile_container`, otherwise `watchface` when it contains `watch_face_fallthrough` or `com.google.android.clockwork.sysui:id/watchface_overlay`. Other captures omit `surface`: SystemUI hosts the watch face, tile and notification tray, so its package and activity alone cannot distinguish them. `ambient` changes power state and reads the watch face's `inAmbient` back from `dumpsys wear_service`.

## Hypotheses to confirm

- Unconfirmed sdkmanager tags: `android-wear`, `android-wear-cn`, `android-automotive`, `android-automotive-playstore` (`sdkmanager --list`). Unconfirmed avdmanager profiles: `wearos_small_round`, `wearos_large_round`, `wearos_rect`, `wearos_square`, `automotive_1024p_landscape` (`avdmanager list device`). TV tags and profiles are confirmed below.
- CtrlProxy installation, host-side accessibility enable and hierarchy observation work unchanged on the verified TV image. Wear has a different Settings app and its enable path remains unverified; service connect plus hierarchy is the first check per Wear image.

## Android TV: go

TV navigation is a focus problem: D-pad keys can be sent and the focused element comes back in every observation. `focusNavigate` is the loop that connects them. `launchApp` tries `MAIN/LEANBACK_LAUNCHER` when `LAUNCHER` resolution finds no activity, including activity-query and package-dump fallbacks. `listApps` includes Leanback entry points in launchability on devices with `formFactor: "tv"`.

1. **Activate focused item.** `enter` activates the focused item on the verified image; `KEYCODE_DPAD_CENTER` is not needed and no `select` key exists. If a future TV image shows that `enter` does not activate, add `select` (`KEYCODE_DPAD_CENTER`) to **both** `SUPPORTED_INPUT_KEYS` and `INPUT_KEY_CODE_MAP`: `InputKeyName` derives from the first and the second is checked against it, so one entry alone does not compile.
2. **`focusNavigate({ until, direction?, maxSteps?, settleMs?, select? })`** (`src/features/action/FocusNavigate.ts`; tvOS reuses the loop through `src/features/tvos/TvosFocusNavigate.ts`, mapping arrows to Siri Remote directions and `enter` to `select`). Observe; stop if the focused element itself or a label it owns matches `until`; else press one D-pad key and repeat. A descendant cannot supply a match when the focused element is scrollable or a separately focusable/clickable control inside it contains that descendant; a card can still match its static child title. `until` matches on `text`, `contentDesc` and `resourceId`; `label` or `elementId`, given alone, names the target as `tapOn` does and pins it with `DpadTargetResolver` (`pinnedFocusOptions`), so a focused parent row cannot stand in for an independently actionable child (combined with other fields it is matched by the loop, which checks every field). Returns the path of focused elements. With `select`, a `focused` result also presses `enter` and reports `selected: true`, and a refused key throws; the tool always reports `selected` (required in its output schema, so a spilled response keeps it inline). The tool records navigation like `tapOn` (`recordsNavigation`), so a public select that changes screen becomes a replayable edge. The select press is reported as the call's dispatch (`ToolDispatchContext`), so the navigation graph times a recorded `focusNavigate` from the key that navigates, not from the first arrow.
   - Direction: given `direction`, else the arrow from the focused element's bounds centre toward the nearest `until` match; with no match on screen, `arrow_right` once per focused Leanback row header (a `row_header` inside the `browse_headers` grid) to enter its content pane, otherwise `arrow_down`. A scrollable headers grid can hide the target header below, so there the headers are scanned down first and `arrow_right` is pressed once `arrow_down` is refused at the last header.
   - Fallback: with a match on screen, a direction is never pressed twice from the same element in one call, and once the directions toward the target are spent the others are tried (perpendicular to the dominant axis, then away from the target), so focus can leave a container that traps it (#17209). Three consecutive presses in one direction that move focus without closing distance to the nearest match (a list scrolling under a fixed slot, a slider changing value) put that direction after the sideways escapes until focus moves another way or gets closer; backing away from the target comes after it, and once every escape from an element fails the direction is pressed again and not demoted for the rest of the call (a list with no side exit still scrolls to the footer). With no match on screen a Leanback row header first tries `arrow_right` once to reveal its content pane; if focus does not move, the scan continues down the headers. Otherwise the absent target scans down.
   - Stops on match, `maxSteps` (default 30), or when no untried direction is left on the current element (an explicit `direction` stops after two unchanged presses). A focused container holding the target is re-read after the settle delay up to twice per press; if it persists, the last direction continues within `maxSteps`. Those container reads do not update stuck/stall tracking or borrow a card label for the path. Focus counts as unchanged only when the focused element's identity fields, bounds and its descendant label all repeat, because a recycler row can keep fixed bounds while the list scrolls under it. The exception is a control that changes its own label in place (#17739): when a press changes the focused element's label but leaves its resource-id, class and bounds unchanged and the screen around it stays put (the same nodes at the same bounds, and no label that was already on screen shown somewhere else) and shows the new value (some node outside focus with a different resource-id shows a new label in place while another keeps its label), the press counts as unchanged and the control is keyed without its label for the rest of the call (a slider announcing its value, which would otherwise read as fresh focus on every value and run to `maxSteps`). Value readouts beside the control (a `Slider Value: 51%` text, a progress bar's description) show new values in place, so they do not count as the screen moving; a fixed-slot recycler row's neighbours shift by one slot, share its resource-id when they repage in place, or are absent when only one row is visible, so it still reads as moving. When such a control has no untried direction left, tab is pressed once and the walk retries; a `stuck` result after that names the control and the directions it consumed. That label is the first contained text or content-desc, falling back to a resource-id only when none has one, since a resource-id such as a Leanback card's `main_image` is shared by every card in a row. Statuses: `focused`, `max_steps`, `stuck`.
   - Why a tool, not an agent loop: one call replaces up to 30 round-trips, and stuck detection needs the previous observation.
   - **Explore** (`src/features/navigation/focusDrivenInput.ts`). It resolves an input mode once per call: D-pad when the device's form factor or `ro.build.characteristics` says `tv`, touch otherwise (an unreadable trait falls back to touch). In D-pad mode `explore` replaces each tap with `focusNavigate { until, select: true }`, where `until` is the element's tap selector as `elementId` or `label`, pinned to the element `tapOn` would tap (so a focused row cannot stand in for a chosen child control) (an element whose selector needs an occurrence `index` is skipped, since `until` cannot tell duplicates apart); it records that call, so `navigateTo` replays the edge as the same D-pad walk. It does not swipe or select a newly found scrollable container, since moving focus is what scrolls it; it advances it instead (`src/features/action/FocusListAdvance.ts`, unrecorded): when focus is elsewhere (discovery picks the list, not what holds focus) it first steers focus toward the container, then presses down a list whose visible rows are stacked (right along a rail whose rows sit side by side, judged from the row-level nodes only, not the labels inside them; the container's long axis without two rows) until a named row that was not on the first read appears inside the container, and treats the list as exhausted when focus does not move for two presses, leaves the list after entering it, or 12 presses pass along it (steering in has its own 12-press bound) (rows already seen never count, so a wrapping list ends on the bound). The advance itself is not recorded. The walk to a card an advance revealed in a horizontal rail is recorded with the rail's `direction: "right"` (`src/features/navigation/RevealedListRows.ts`, which keeps each advanced list's revealed row identities for the exploration), because on replay the rail is back at its first cards and the default absent-target scan within the rail presses down. A card counts as revealed when its own identity or any one of its names was among the advance's new rows, since explore labels an unlabelled card from its child while the advance reports the two separately. The direction is added only while focus is in that rail on the card's row at or before it, so the live walk also reaches it (a control below the cards keeps the default walk); a row revealed in a vertical list keeps the default walk, whose downward scan already scrolls the list. A recorded `focusNavigate` that targets a scrollable container still replays; validate mode skips a recorded edge it cannot act on this way (a `swipeOn`, or an element with no focus target) rather than retrying it. Like a tap, the walk flushes pending post-action captures first, and a successful select waits a bounded settle (1 s) while its record is live, so the navigation it causes is attributed to it. Validate mode replays a recorded `focusNavigate` edge as a focus walk on any device, touch included, with its recorded `until`, walk options and `select` (a call that navigated on focus alone presses no enter), and finds the on-screen element the way the replay will: a lone `label` or `elementId` with the same resolver the walk pins it with (a resolved static child maps to the smallest candidate containing it, as focus on that owner counts), any other target with `focusNavigate`'s matcher (every `until` field on one element, exact labels first; a match only on a static descendant in the hierarchy maps to the candidate containing it), falling back to the label fields alone when the target is a label inside a clickable row. The abort signal reaches each key press, so a cancelled run sends no further keys, and it ends the waits between them: the input-mode probe, each walk's or advance's per-press settle, and the select settle, so a cancel waits at most for the key press or hierarchy read in flight. A recorded `tapOn` edge replays as `tapOn`, which takes the D-pad path itself on a device without a touchscreen.
3. **TV matching.** Extend `FormFactor` with `tv`, classified from system-image tag first, geometry second.

`focusedElement` follows Leanback's focus ring (`focused: true`). `swipeOn` works on the verified image, which reports a touchscreen though `getevent -pl` lists no touch input device (only `gpio-keys`). A device counts as touchless when `pm has-feature android.hardware.touchscreen` is `false`, or when it is `true` but `android.software.leanback` or `android.hardware.type.television` is `true` (TV emulator images declare the touchscreen anyway); an unreadable TV-feature probe keeps touch and is not cached. On a touchless device `tapOn` with a `text` or `elementId` selector and a plain tap runs `focusNavigate` to the match and presses `enter`, returning `inputMethod: "dpad"` and the focus walk (`src/features/action/DpadTapOn.ts`); On each focus read the target is resolved with the touch path's own `ElementSelector` and options (`src/features/action/DpadTargetResolver.ts`), so placeholder (hint-text) fallback, exact-before-contains, ranking, actionable-ancestor promotion and synthetic `view-id`s pick the same element for D-pad and touch; focus then steers to that element's bounds, and a resolved target that is itself clickable or focusable must hold focus: a focused parent row does not count for an independently actionable child inside it. Only when a read carries no hierarchy does `FocusNavigate` match itself: `text` against text or content-desc after the resolver's normalization, exact matches first, the first-ranked match (smallest area, then hierarchy order) pinned, and `elementId` against the native `resource-id` or synthetic `view-id`. Enter is not pressed when the request was cancelled during navigation. `pm has-feature` prints `false` and exits 1 for a missing feature, so that rejected output is read as the answer. The probe answer is cached per device for five minutes; a failed probe keeps the touch path. On a touchless device a request only a touch tap can serve (sibling, container, index, searchUntil, ensureChecked with either value, layer, display, exactText, a non-`first` selection strategy, a `testTag` or `textAny` selector, another action) is refused with an `ActionableError` naming each such part and the plain-selector D-pad form, because an injected touch tap there is a silent no-op that would report success; the probe therefore runs before that check, and a device with a touchscreen still takes the touch path. Semantic-link requests (`selector.accessibilityLink`, owner-scoped `subtext`) skip both the probe and the refusal: the accessibility service invokes the span's click handler, so no touch is injected. This mirrors tvOS, where `tapOn` already selects by focus. No-touchscreen behaviour remains unverified on a device. Google TV is unverified. `focusNavigate` accepts a static child label owned by the focused control, but continues navigating when a focused container merely holds a separately actionable target. Prototype overlay buttons are not reachable with D-pad focus.

### Android TV: behaviour and limits

The TV image is `system-images;android-36;android-tv;arm64-v8a` with profile `tv_1080p` (1920×1080 at 320 dpi), a user build that refuses `adb root`. The SDK tags `android-tv`, `google-tv`, `google-tv-ps16k` and the profiles `tv_1080p`, `tv_4k`, `tv_720p` match `src/models/formFactor.ts`. CtrlProxy installs and its accessibility service enables from the host with no TV-specific setup, and `observe` returns the hierarchy for the launcher and Settings.

`focusedElement` follows the Leanback focus ring. `sendKeys` arrows move focus and `enter` activates. `focusNavigate` matches the target's own `contentDesc` or `resourceId`, and a static child label counts when it belongs to the focused control. Scrollable containers and ancestors of separately actionable controls cannot borrow those controls' labels. `pressButton` back and home, screenshots and video recording work. `launchApp` and `terminateApp` work for apps that only have a `LEANBACK_LAUNCHER` entry, and `listApps` includes them. The prototype overlay renders and dismisses, but its button is not reachable with D-pad focus. `observe.accessibilityState` reports the service as disabled and unknown while it is bound, which is an unexplained oddity.

**Signals and classification.** `ro.build.characteristics` is `emulator`, with no `tv`. Booted-device traits (`src/utils/android-cmdline-tools/deviceTraits.ts`) derive `formFactor` from this property, and on an emulator with no form factor there they fall back to `pm has-feature android.software.leanback`. AVD classification comes from the config's system-image tag or `tv_*` profile. The image reports `android.software.leanback`, `android.hardware.type.television`, `android.software.leanback_only` and `android.hardware.touchscreen` as present.

**Not covered:**

- The Google TV image; only `android-tv` was booted.
- Real no-touchscreen behaviour.
- D-pad reach of prototype overlays (known gap).

### TV fixture apps

Two deterministic targets for TV checks and focus regression tests, with no network, no video decoding
and no Google account. Each has `LAUNCHER` and `LEANBACK_LAUNCHER` entries, a banner, and declares
touchscreen and leanback optional, so it installs on any TV or phone image at API 28 or later. Rows,
cards, search text and player tracks come from each module's catalog object; screen tags, button labels
and the player's state lines are the ones listed below. Changing either is a contract change.

Both embed the AutoMobile SDK and report each screen as an SDK navigation event, so `explore` records
them in the navigation graph and `navigateTo` can replay them. Screen names are part of the contract:
`BrowseDestination`, `SearchDestination`, `DetailDestination` (argument `cardId`) and
`PlayerDestination`; the Leanback fixture has only Browse and Detail. A screen is reported when it is
shown and again whenever the app resumes on it.

`android/tv-fixture` (`dev.jasonpearson.automobile.tvfixture`, launcher "AutoMobile TV Fixture") is
Compose for TV (`androidx.tv:tv-material`). Compose test tags are exposed as resource ids.

- Browse (`browse_rows`): the title, `Search` (`nav_search`) and `Player` (`nav_player`) buttons, the
  status line (`fixture_status`, starts `Ready`) and the focus line (`fixture_focus`, `Focused: none`
  until a card takes focus, then `Focused: Movies 03`). Below them the rows `row_featured`, `row_movies`
  and `row_shows`, each a `LazyRow` of 12 cards (`card_movies_01`..`card_movies_12`, titled
  `Movies 01`..`Movies 12`). About four and a half cards fit a 1080p row, so D-pad right past the last
  visible card scrolls the next one into view. Focus starts on `Featured 01`, also after back.
- Selecting a card opens its detail (`detail_title`, `detail_text` = `Detail for Movies 03`, focused
  `Play` = `detail_play`) and sets the status to `Selected Movies 03`. `Play` opens the player.
- Search (`search_field`, focused on entry): case-insensitive title match. `search_summary` reads
  `Type to search`, `No results`, `1 result` or `N results`; matches are cards in `search_results`.
- Player: `player_track` (`Track 1 of 3: Opening Titles`), `player_state` (`Paused`/`Playing`),
  `player_position` (`0:00 / 3:00`), `player_last_command` (`Last command: none`) and the buttons
  `player_previous`, `player_rewind`, `player_play_pause` (focused), `player_fast_forward`,
  `player_next`. Nothing plays and the position never ticks (the session publishes speed 0): fast-forward and rewind move 10 s, clamped
  to the track; next and previous change track, clamped to the 3-track playlist, and reset the position.
- Media keys: the activity owns a framework `MediaSession` (active for the activity's lifetime, state
  and metadata published on every change) and sets it as its window's media controller, so unhandled
  media keys reach it on every screen, as do transport controls from another controller. Play/pause
  (85, and headset hook 79), play (126), pause (127), stop (86), fast forward (90), rewind (89), next
  (87) and previous (88) run the same command as the on-screen buttons on the first down event of a
  press; `player_last_command` names it with `pressButton`'s button name (`playPause`, `fastForward`,
  `rewind`, `next`, `previous`). A recreated activity starts the player over.

`android/leanback-fixture` (`dev.jasonpearson.automobile.leanbackfixture`, launcher "AutoMobile
Leanback Fixture") is View-based Leanback: a `BrowseSupportFragment` titled `AutoMobile Leanback` with a
headers column (`Featured`, `Movies`, `Shows`) and one `ListRow` of 12 `ImageCardView` cards per header,
titled as in the Compose fixture with the card id as the content text. Selecting a card opens
`DetailActivity` (`detail_title`, `detail_text`). No search listener is set, so there is no search orb
and nothing asks for audio.

## Wear OS: conditional go

Hierarchy and tap path should match a phone's; the gaps are three Wear-specific inputs, none confirmed.

- **Rotary.** `rotaryScroll({ delta })` (`src/features/wear/RotaryScroll.ts`, opt-in like `windowMode`) tries, in order, `adb shell input rotaryencoder scroll --axis SCROLL,<-delta>`, `adb emu event send EV_REL:REL_WHEEL:<delta>` (emulator serials only) and a vertical centre-column `input swipe` sized from `wm size`. After each it re-reads the CtrlProxy hierarchy; a candidate counts only if the structural fingerprint changed. The result names the first working `method` and lists every attempt; on a device whose `ro.build.characteristics` does not name `watch` (device traits `formFactor`) the input is still sent and the result carries a `warning`. The hierarchy has no scroll offset, so a list already at its end reports `unchanged`, and an unreadable hierarchy (CtrlProxy disconnected) makes no attempt. The native SCROLL axis command is confirmed on a Wear OS emulator, with its sign inverted relative to delta: positive delta reveals lower items. The emulator-console `REL_WHEEL` mapping and sign, and physical-device behaviour, remain unconfirmed (checklist row 6).
- **Ambient.** `ambient({ action: "enter" | "exit" })` sends `KEYCODE_SLEEP` or `KEYCODE_WAKEUP` through the existing power client, then reads wakefulness and `watchFaceState=WatchFaceState{watchFaceVisible=…, inAmbient=…}` from `dumpsys wear_service` (parsed in `src/features/wear/wearServiceDumpsys.ts`, shared with watch-face observation). Enter succeeds on `inAmbient=true`; exit on `inAmbient=false` with `Awake`. Without that line (or when the read fails) the result reports `ambient: "unknown"` and falls back to wakefulness: enter on `Dozing` or `Asleep`, exit on `Awake`. On the API 37 image `KEYCODE_SLEEP` also takes the display to `DOZE_SUSPEND`, and `svc power stayon true` keeps it awake. Hardware wake by tilt or touch remains untested.
- **Round screens.** `observe` reports `isScreenRound` for `watch` devices (`BootedDevice.formFactor`), read over adb from `dumpsys display` (`FLAG_ROUND` on the default display's `DisplayInfo`/`DisplayDeviceInfo` record), not from the CtrlProxy.
- **Swipe-to-dismiss.** Wear OS 3+ back is a right-swipe from the left edge; the `back` global action should work; check a left-edge `swipeOn`.

## Android Auto (DHU): no-go

The DHU is a host desktop app; the phone's Android Auto app streams the car UI as video over an ADB-forwarded socket (`tcp:5277`), and Car App Library templates are rendered by the host, not the app under test. So the phone's accessibility tree has no car screen, and driving the DHU is desktop automation outside the ADB model. `androidx.car.app.testing` (`TestCarContext`, `ScreenController`) tests templates in unit tests and is the recommended route.

### Measured on a Play phone emulator

Measured on a Mac arm64 host with DHU 2.1 (`Build: 2022-12-15-495527557`) against a `google_apis_playstore` API 36 phone emulator.

- **The Play image's Android Auto is a stub.** There is no head-unit server to project from until a person signs in to Play or sideloads a trusted Android Auto APK:

  ```
  package:com.google.android.projection.gearhead
      versionName=1.2.551000-stub
  ```

  `com.android.settings.action.SETTINGS` resolves to `com.google.android.projection.gearhead/com.google.android.apps.auto.components.app.stubapp.StubSettingsActivity`; starting it ends on `com.android.vending/com.google.android.finsky.unauthenticated.activity.UnauthenticatedMainActivity` (the Play sign-in wall), so Developer settings and **Start head unit server** are unreachable. Automated lanes must not sign in, so this step stays with a person.

- **The DHU exits against the stub.** With `adb forward tcp:5277 tcp:5277` and `desktop-head-unit --headless -a localhost:5277`, the DHU connects at the adb layer and exits when the transport drops, because nothing listens on the phone's 5277:

  ```
  [W]: No configuration specified - using default values.
  [E]: Could not load configuration from '~/.android/headunit.ini'.
  BoringSSL is the SSL implementation used in the receiver-lib.
  Starting link. Requested protocol version: 1.7
  [I]: Connecting over ADB to localhost:5277...
  [I]: connected.
  Android Auto - Desktop Head Unit
    Build: 2022-12-15-495527557
    Version: 2.1-mac-arm64

  > [E]: Failed to read from transport - disconnect. Exiting...
  ```

  (The `connected.` line carries ANSI colour codes in the raw output.)

- **Console commands.** Read from the installed binary's strings, not from a live `help`: `dpad <up|down|left|right|click|back|soft left|soft right|flick left|flick right|rotate left|rotate right|ul|ur|dl|dr|0-9|#|*|+>`, `rotary`, `day`, `night`, `mic begin|reject|repeat`, `focus <audio|nav|video|video toggle>`, `screenshot <filename.png>` ("Save screenshot to filename in PNG format."), `sleep <seconds>` and `quit`. There is no coordinate `tap` command: touch comes from the DHU window pointer, so an automated driver would go through `dpad`/`rotary` or window-level input.

- **Shipped configs.** `extras/google/auto/config` ships `all_720p auxillary_nav cluster default default_1080p default_6in default_720p default_sensors default_wide hybrid loaded_720p rotary touchpad` (`.ini`), selected with `-c`/`--config`. `default.ini` is `resolution = 800x480`, `dpi = 160`, `framerate = 30`.

- **Unverified.** A live `help`, `screenshot` and phone-side `observe` during projection need a real projection session and are unverified until a person completes the Play sign-in step. Projected UI is expected to be absent from the phone-side `observe`, because the host renders it into the head unit.

## Android Automotive OS: go

### CtrlProxy setup for the foreground user (#14918)

An automotive image usually has a headless system user, so the driver is a secondary user (often 10).
`pm grant` and `pm path` default to user 0, `pm list packages` to all users, and `dumpsys accessibility`
dumps every user's state in id order (so an untargeted read sees user 0's empty one); `settings` already
follows the current user on Android 10+. When the booted device's `formFactor` is `automotive`,
`resolveSetupUser` (`src/ctrlProxy/setupUser.ts`) reads `am get-current-user` and CtrlProxy's install
check, enabled-services read, enable, disable, rebind writes and the local-network grant target that user,
and the rebind health check reads that user's `User state[` block. A device that is not automotive issues
no extra command and the exact commands it always did. An unreadable user is an `ActionableError` naming
the user problem. User 0 is the driver only on a build without a headless system user: when an automotive
device reports user 0, `ro.fw.mu.headless_system_user` (what `UserManager.isHeadlessSystemUserMode()`
reads) is checked, and on a headless build the read throws `ForegroundUserPendingError`. Runner readiness
treats that like a missing framework service and retries setup within its budget, so `sys.boot_completed`
alone never lets CtrlProxy be set up for user 0 before the switch to the driver user. A freshly
created AVD can also answer the first setup command with `adb: device still authorizing` before it
finishes the adb key handshake; readiness retries that within the same budget too, so the
create-and-boot path does not roll back the new AVD for it. Verified on the API 34 image below; the gate relies on the AVD's form factor, so a
physical head unit is not covered.

An AAOS image is a normal Android build with a car SystemUI; app windows are in the accessibility tree.

### Automotive baseline on an emulator

Main image: `system-images;android-34-ext9;android-automotive;arm64-v8a` (`userdebug`, headless system
user, driver user 10), profile `automotive_1024p_landscape`. Rows marked _Play_ were run on
`android-35-ext15` `android-automotive-playstore` (`user` build, `adb root` refused).

| Tool or behaviour                                               | Result | Notes                                                                                                           |
| --------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| `provisionDevice` with an explicit `android-automotive` runtime | Pass   | Creates and boots the AVD                                                                                       |
| `startDevice` `formFactor: "automotive"`, `createIfMissing`     | Pass   | Finds `android-<api>-ext<N>` images; repeated creation on a _Play_ image still needs a device run (#15879)      |
| `formFactor` in `listDevices` / `getAndroid`                    | Pass   | `automotive`                                                                                                    |
| CtrlProxy install and enable for the driver user                | Pass   | Enabled for user 10 only; readiness waits for the switch from user 0                                            |
| `observe` (hierarchy and screenshot)                            | Pass   | Main display only                                                                                               |
| `tapOn`, `tapAt`, `swipeOn`                                     | Pass   |                                                                                                                 |
| `launchApp`, `listApps`                                         | Pass   | Launch targets the foreground user                                                                              |
| `pressButton` `home`                                            | Pass   | The home screen is hosted by `com.android.car.mapsplaceholder`                                                  |
| `pressButton` `rotary_rotate_cw` / `_ccw`, `rotary_nudge_*`     | Pass   | `rotary_select` succeeds with no observable effect tied to it                                                   |
| `rotaryScroll`                                                  | n/a    | Wear-only; on a car it warns and falls back to a swipe                                                          |
| `performanceTrace`                                              | Pass   |                                                                                                                 |
| `deviceCondition` `vehicle.motion` driving / parked / reset     | Pass   | `Current Driving State` 2 held, then 0; on _Play_ the car service refuses it and the tool returns `unsupported` |
| `deviceCondition` `vehicle.nightMode`                           | Pass   | Effective UI night mode flips and restores; car service accepts it on _Play_ too                                |
| `prototype` `show` / `status` / `dismiss` (_Play_)              | Pass   | Reports `formFactor: "automotive"`; `save` `pin:true` reports `pinned: "unsupported"`                           |

Car-service commands: `inject-vhal-event`, `emulate-driving-state` and `get-property-value` need a
non-`user` build; `enable-uxr` is refused from `adb shell` on every build (system signature); restriction
state is read from `dumpsys car_service --services CarUxRestrictionsManagerService` and
`CarDrivingStateService`, which work on both builds. Cluster and passenger displays are unchecked.

### Automotive fixture app

`android/automotive-fixture` (`dev.jasonpearson.automobile.automotivefixture`) is the deterministic
target for automotive checks: no network and no Google services, so it installs on non-Play images.
All text and ids come from `FixtureCatalog` and `MediaBrowseTree`; changing them is a contract change.

- `DrivingSafeActivity` (launcher "AutoMobile Fixture", declared `distractionOptimized`): a status line
  (`fixture_status`) and a list (`fixture_rows`) whose first row opens `ParkedOnlyActivity` and whose
  `Row 01`..`Row 20` set the status to `Selected Row NN`.
- `ParkedOnlyActivity`: no `distractionOptimized` meta-data, so it is blocked while driving.
- `FixtureMediaBrowserService`: a framework `MediaBrowserService` serving two albums and a playlist of
  three tracks each; playing an item only updates the session state.
- `FixtureCarAppService` (navigation category, launcher "AutoMobile Templates" via `CarAppActivity`):
  list, grid, pane and place-list navigation templates with fixed rows and four fixed places, plus a
  `List 30` screen with `List long row 01`..`List long row 30` (`list_long_row_01`..`list_long_row_30`).
  Debug builds enable the AutoMobile SDK template route and record every screen's returned template,
  including all thirty rows regardless of host truncation; release builds omit the SDK. It accepts every
  templates host, so a non-Play image needs a templates host of its own to render it.

### Wear fixture app

`android/wear-fixture` (`dev.jasonpearson.automobile.wearfixture`, launcher "AutoMobile Wear Fixture")
is the deterministic target for watch checks: Compose for Wear OS, no network and no Google account,
standalone, so it installs on any Wear image. All text and ids come from `WearFixtureCatalog`; changing
them is a contract change. Compose test tags are exposed as resource ids.

- Home (`fixture_list`, a `ScalingLazyColumn`): the status line (`fixture_status`, starts `Ready`), six
  action buttons (`action_picker`, `action_dismiss`, `action_confirm`, `action_notify`,
  `action_ongoing_start`, `action_ongoing_stop`), then `Item 01`..`Item 30` (`item_01`..`item_30`).
- Detail (`detail_title`, `detail_text` = `Detail for Item NN`): back or a right swipe returns home.
- Rotary picker (`picker`, `picker_value`): `Level 0`..`Level 11`, clamped. Only rotary scroll events
  move it (48 px per step); it has no touch handler. Each step sets the status to `Picked Level N`.
- Swipe-to-dismiss screen (`dismiss_screen`): a right swipe pops it and sets the status to `Dismissed`.
  Detail and picker pop the same way.
- Confirmation dialog: `Confirm` (`confirm_button`) or `Cancel` (`cancel_button`) set the status to
  `Confirmed` or `Cancelled`.
- Notification (`Fixture alert`): actions `Reply` and `Archive` reopen the app with the status
  `Notification action: Reply` / `Archive`. The ongoing activity (`Fixture run`) is an ongoing
  notification started and stopped from home. Both need `POST_NOTIFICATIONS`; the app asks on first use,
  and `pm grant` skips the prompt.
- `FixtureTileService`: one clickable (`tile_open_item`) that opens `Item 07`'s detail.
- `FixtureComplicationService`: `SHORT_TEXT` (`Item` / `07`) and `RANGED_VALUE` (7 of 0..10, `7/10`);
  tapping opens `Item 07`'s detail. Values are fixed and never polled.

## Device selection change

1. Extend `FormFactor` and `BINDING_DEVICE_FAMILIES` with `tv`, `watch`, `automotive`.
2. In `formFactorFrom`, classify from the system-image tag before geometry.
3. Surface form factor in `getAndroid` and the device description so a `requires` clause (#4680) can ask for it.

Needs no device to build; phones, tablets and foldables keep the same geometry path.

## Verification checklist

Record command, image id and API level.

| #   | Image                                    | Check                                                                                                                                                                    |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | TV (`android-tv` or `google-tv`, API 34) | `avdmanager create avd` with `--device tv_1080p` succeeds; the AVD boots                                                                                                 |
| 2   | TV                                       | `adb install` of the CtrlProxy APK succeeds; the service can be enabled from the host; `observe` returns a hierarchy                                                     |
| 3   | TV                                       | `sendKeys` with `arrow_right` moves focus and `observe.focusedElement` changes; `enter` and, if that does not work, `KEYCODE_DPAD_CENTER` activate the focused item      |
| 4   | TV                                       | `tapOn` works on an image with no touchscreen                                                                                                                            |
| 5   | Wear (`android-wear`, API 34)            | The same install, enable and `observe` checks as TV                                                                                                                      |
| 6   | Wear                                     | Each rotary candidate against a `ScalingLazyColumn`: which one changes the scroll position                                                                               |
| 7   | Wear                                     | `ambient` uses `KEYCODE_SLEEP`/`KEYCODE_WAKEUP`; `inAmbient` in `dumpsys wear_service` follows it (verified on API 37). Hardware wake by tilt or touch remains untested. |
| 8   | Wear                                     | `isScreenRound` is true on `wearos_small_round`; the left-edge swipe dismisses a screen                                                                                  |
| 9   | Automotive (`android-automotive`)        | Behavior of the cluster and passenger displays (install, enable and `observe` are in the baseline above)                                                                 |
| 10  | Any                                      | `sdkmanager --list` shows the tags named above; `avdmanager list device` shows the profile ids                                                                           |

## Not covered

Android Auto projection is a documented no-go. Automotive OS secondary displays (row 9) remain unchecked.
