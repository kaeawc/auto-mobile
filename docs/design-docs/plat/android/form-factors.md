# Android form factors: TV, Wear OS and Android Auto

Spike notes for #14118, part of #14072.

> [!WARNING]
> **Not yet verified on an emulator.** The cloud container this was written in has no
> KVM, emulator or Android SDK, so no command below was run. The note separates two kinds
> of statement:
>
> - **Verified in the repo** means read from this checkout, with a file reference.
> - **Hypothesis** means written from AOSP and Android documentation, and unconfirmed.
>
> The go/no-go verdicts are provisional for that reason. The verification checklist at the
> end lists what to run on each image before a verdict counts as evidence. Follow-up
> issues each start with that checklist item.

## Verdicts

| Form factor                                  | Verdict            | Smallest useful tool surface                                           | Main risk                                                                  |
| -------------------------------------------- | ------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Android TV / Google TV                       | **Go**             | `focusNavigate`, a `select` key on `sendKeys`, TV form-factor matching | The CtrlProxy has never been run on a TV image                             |
| Wear OS                                      | **Conditional go** | rotary scroll, `isScreenRound` in `observe`, ambient toggle            | Every rotary and ambient command is unconfirmed                            |
| Android Auto (projection to a DHU)           | **No-go**          | none                                                                   | The car UI is not in any accessibility tree AutoMobile can read            |
| Android Automotive OS (an AAOS system image) | **Investigate**    | none yet                                                               | Not named in the issue, but it is a normal Android image and may just work |

Android Auto and Android Automotive OS are different products. Android Auto projects a
phone's UI to a head unit. Automotive OS is a full Android build that runs on the car. The
issue says "Android Auto"; the feasible variant is Automotive OS, so both are covered.

## What the repo does today

### Device selection and matching

**Verified in the repo.**

- The form-factor vocabulary is `phone | tablet | foldable | unknown`
  (`src/models/DeviceMatchCriteria.ts`). A binding's `family` is limited to
  `phone | tablet | foldable` (`BINDING_DEVICE_FAMILIES` in
  `src/utils/provisionDeviceSpecSchemas.ts`).
- `formFactorFrom` (`src/models/formFactor.ts`) classifies by profile name for
  fold/flip, then by geometry: a diagonal of at least 7 inches at the reported density is a
  tablet, anything else is a phone. A TV would therefore be reported as a tablet and a
  watch as a phone, and a binding that asks for `tablet` would match a TV.
- `provisionDevice` takes `runtime` as a system-image package id. The parser
  (`parseAndroidSystemImageRuntime`) accepts any tag between the API level and the ABI. Only
  `google_apis_playstore` is special-cased. So a TV, Wear or Automotive image id is
  accepted by the schema, and no code names a TV, Wear or Automotive tag.

**Hypothesis.** The sdkmanager system-image tags for these form factors are `android-tv`,
`google-tv`, `android-wear`, `android-wear-cn`, `android-automotive` and
`android-automotive-playstore`. Confirm with `sdkmanager --list`. The avdmanager device
profiles are expected to include `tv_1080p`, `tv_4k`, `wearos_small_round`,
`wearos_large_round`, `wearos_rect`, `wearos_square` and `automotive_1024p_landscape`.
Confirm with `avdmanager list device`.

### The CtrlProxy

**Verified in the repo.**

- `minSdk` is 24 (`android/gradle/libs.versions.toml`). That is at or below the API
  levels of the TV, Wear and Automotive images worth targeting, so it is not the blocker.
- The manifest declares no `<uses-feature>`, and the only launcher category is `LAUNCHER`
  (no `LEANBACK_LAUNCHER`). The accessibility service config
  (`accessibility_service_config.xml`) asks for window content, interactive windows and
  gesture dispatch.

**Hypothesis.** An `adb install` does not filter on `<uses-feature>` (only Play does), so
the APK should install on every form factor. Enabling the accessibility service from the
host should work the way it does on a phone, but TV and Wear system images ship a different
Settings app, and the enable path that AutoMobile uses has never been run on them. Whether
the service connects and returns a hierarchy is the first thing to check on each image.

### Input and focus

**Verified in the repo.**

- `sendKeys` supports only the arrow keys, enter, tab, escape, backspace and delete
  (`INPUT_KEY_CODE_MAP` in `src/features/action/InputKey.ts`, exposed as the `sendKeys` tool). The arrows already map to
  `KEYCODE_DPAD_*`. There is **no D-pad centre / select key**, no menu key and no media key.
- `pressButton` sends back, home and recent as accessibility global actions with an ADB
  fallback, and the hardware keys (volume, power) through ADB (`PressButton.ts`).
- `observe` already returns the input-focused element: `focusedElement`
  (`src/features/observe/ActiveWindowAttribution.ts`), found by the `focused` property
  (`src/features/observe/HierarchyFocus.ts`). The accessibility (TalkBack) focus is reported
  separately as `accessibility-focused`. The Kotlin node carries a `focused` flag
  (`StructuralHasher.kt` hashes it).
- Nothing in `src/` or the CtrlProxy reads `isScreenRound` or handles ambient mode.

## Android TV

### Why "go"

TV navigation is a focus problem, and the pieces AutoMobile needs are mostly in place:
the D-pad keys can be sent and the focused element comes back in every observation. What is
missing is a loop that connects them, and one key.

### Proposed surface

1. **`sendKeys` gains `select`** (`KEYCODE_DPAD_CENTER`). Without it the agent can move
   focus but cannot activate anything. This is a one-entry change to `INPUT_KEY_CODE_MAP`.
2. **`focusNavigate({ until, direction?, maxSteps?, settleMs? })`.** It observes, stops if
   the focused element matches the selector `until`, otherwise presses one D-pad key
   and observes again. It returns the path of focused elements, so a failure shows where
   focus went.
   - **Direction choice.** If `direction` is given, use it. Otherwise pick the arrow
     that moves from the centre of the focused element's bounds toward the centre of the
     nearest element matching `until`. If nothing matching is on screen yet, scroll
     direction defaults to `arrow_down`.
   - **Stop conditions.** It stops on a match, after `maxSteps` (default 30), or when two
     consecutive presses leave focus unchanged (a focus trap or an unfocusable target).
     Each exit reports a distinct status: `focused`, `max_steps`, `stuck`.
   - **Why a new tool and not a loop in the agent.** One call replaces up to 30
     round-trips, and the stuck detection needs the previous observation.
3. **TV form-factor matching.** Extend `FormFactor` with `tv`, classified from the
   system-image tag first (`android-tv`, `google-tv`) and geometry second.

### Open questions for the device

- Does the existing `tapOn`/`swipeOn` path work on a TV image that has no touchscreen? The
  gesture dispatch API needs a display but not a digitizer, so it may.
- Does the focused-element flag appear for the focus ring Leanback draws, or only for
  views that hold input focus? If it is only the latter, `focusNavigate` needs the
  accessibility focus too.

## Wear OS

### Why "conditional go"

The hierarchy and tap path should work like a phone's, and the gaps are three Wear-specific
inputs. Each has a candidate command, none confirmed.

### Rotary input

**Hypothesis.** Candidates, in order, each followed by a read-back (a changed scroll
position in the next `observe`) in the style of the `windowMode` tool:

1. `adb shell input rotaryencoder scroll <delta>`. Recent AOSP `Input.java` lists a
   rotary-encoder source, but which API level first has it is unknown.
2. The emulator's rotary control through its console, if one exists.
3. `KEYCODE_STEM_PRIMARY` and the `KEYCODE_STEM_*` keys for the crown press. These are
   buttons, not scroll.

If none of these moves a `ScalingLazyColumn`, the fallback is a vertical swipe, which the
existing `swipeOn` already provides.

### Ambient mode

**Hypothesis.** Wear's ambient mode is entered by the screen timing out into the
always-on display, not by a documented shell command. Candidates to try:
`input keyevent KEYCODE_SLEEP` followed by a wake, and the always-on-display settings key.
This is the least certain area; if no command reliably enters and leaves ambient mode, the
verdict for ambient testing is no-go and the rest of the Wear surface is unaffected.

### Round screens and swipe-to-dismiss

- **Round insets.** `observe` should report `isScreenRound` (`Configuration.isScreenRound`)
  so an agent knows the corners are cut off. Nothing reports it today. The change is a new
  field on the display info.
- **Swipe-to-dismiss.** On Wear OS 3 and later the back gesture is a right-swipe from the
  left edge. The `back` global action should already work; a swipe from the left edge
  through `swipeOn` is the check.

## Android Auto (DHU): no-go

**Hypothesis**, from the Android for Cars developer documentation. The Desktop Head Unit is
a host desktop application. The phone's Android Auto app streams the car UI to it as video
over an ADB-forwarded socket (the documented setup forwards `tcp:5277`). The templates in
the Car App Library are rendered by the host (the Android Auto app), not by the app under
test.

That means:

- The phone's accessibility tree contains the phone app, not the car screen. The CtrlProxy
  would see nothing of what the car shows.
- Driving the DHU would mean screenshotting and clicking a window on the developer's
  desktop. That is a desktop-automation job and outside AutoMobile's ADB model.
- The Car App Library already ships `androidx.car.app.testing` (`TestCarContext`,
  `ScreenController`), which tests templates directly in the app's own unit tests, with no
  emulator and no projection. It is the right tool for template logic.

**Verdict: no-go.** Document `androidx.car.app.testing` as the recommended route and leave
it out of the tool surface.

### Android Automotive OS: investigate

An AAOS image is a normal Android build with a car SystemUI. Unlike the projection case, the
app runs on the device and its windows are in the accessibility tree. If the CtrlProxy
connects there, most existing tools work, with the same three questions as TV: does the
service enable, does `observe` return the hierarchy, and does multi-display (cluster and
passenger screens) behave as it does in the windowing note
(`docs/design-docs/plat/android/windowing.md`). Add this to the verification checklist and
decide after the first run.

## Device selection

`provisionDevice` and `getAndroid` already accept the right inputs (a system-image id and
an avdmanager profile); they do not classify the result correctly. The change is small:

1. Extend `FormFactor` and `BINDING_DEVICE_FAMILIES` with `tv`, `watch` and `automotive`.
2. In `formFactorFrom`, classify from the system-image tag before geometry, so a TV is never
   reported as a tablet.
3. Surface the form factor in `getAndroid` and the device description so a `requires` clause
   (see #4680) can ask for it.

None of this needs a device to build, and none of it changes behavior for phones, tablets
and foldables, which take the same geometry path as today.

## Verification checklist

Run on a booted image of each kind. Record the command, the image id and the API level.

| #   | Image                                    | Check                                                                                                                            |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | TV (`android-tv` or `google-tv`, API 34) | `avdmanager create avd` with `--device tv_1080p` succeeds; the AVD boots                                                         |
| 2   | TV                                       | `adb install` of the CtrlProxy APK succeeds; the service can be enabled from the host; `observe` returns a hierarchy             |
| 3   | TV                                       | `sendKeys` with `arrow_right` moves focus and `observe.focusedElement` changes; `KEYCODE_DPAD_CENTER` activates the focused item |
| 4   | TV                                       | `tapOn` works on an image with no touchscreen                                                                                    |
| 5   | Wear (`android-wear`, API 34)            | The same install, enable and `observe` checks as TV                                                                              |
| 6   | Wear                                     | Each rotary candidate above against a `ScalingLazyColumn`: which one changes the scroll position                                 |
| 7   | Wear                                     | Which command, if any, enters and leaves ambient mode                                                                            |
| 8   | Wear                                     | `isScreenRound` is true on `wearos_small_round`; the left-edge swipe dismisses a screen                                          |
| 9   | Automotive (`android-automotive`)        | Install, enable and `observe`; behavior of the secondary displays                                                                |
| 10  | Any                                      | `sdkmanager --list` shows the tags named above; `avdmanager list device` shows the profile ids                                   |

## Follow-ups

Filed under #14072, each gated on its checklist rows:

- **TV:** `sendKeys` `select`, `focusNavigate`, and the TV form factor (rows 1 to 4).
- **Wear OS:** rotary scroll, `isScreenRound`, and ambient toggle if row 7 finds a command
  (rows 5 to 8).
- **Form-factor vocabulary:** `tv`, `watch` and `automotive` in matching, classified by
  system-image tag, which applies to all of the above and can be built first.

Android Auto projection is a documented no-go. Automotive OS has no follow-up until rows 9
and 10 are run.
