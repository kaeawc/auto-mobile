# Prototype web frames for every form factor

The prototype web renderer's device frames describe one screen. This note sets out the frame
schema that covers foldables in every posture, watches, TVs and cars, and how the renderer and a
spec behave on each. The single-screen registry is described in
[Prototype web renderer](prototype-web-renderer.md).

## Vocabulary the frames reuse

The frames reuse what the repository already models, so one vocabulary drives a real device, a
spec and the web page:

- Form factors: `phone`, `tablet`, `foldable`, `tv`, `watch` and `automotive`
  (`src/models/formFactor.ts`).
- Panel roles and postures: `inner`, `cover`, `rear` and `external`; `closed`, `half_opened`,
  `opened`, `rear_display`, `flipped` and `tent` (`src/models/DisplayPanel.ts`), the names
  `setPosture` takes. `POSTURE_PANEL_ROLES` says which panel a posture lights.
- What a spec can read: platform state `/device/widthClass` (`compact`, `medium` or `expanded` at
  600 and 840 dp on Android; `compact` or `regular` on iOS) and, on Android, `/device/posture`
  (`flat`, `tabletop` or `book`), from `platformModules.device.state` in the prototype contract.

## Frame schema v2

A v2 frame adds four optional fields to a v1 frame. A v1 entry is a v2 frame with one panel, so
existing entries stay valid and keep their meaning.

- `formFactor`: one of the form factors above; `phone` when omitted.
- `panels`: a list of screens, each with a `role` and the v1 screen fields (`screen`,
  `cornerRadiusDp`, `cutout`, `statusBarDp`, `navBar`, `safeArea`). The v1 top-level screen fields
  are panel 0 with role `inner`.
- `hinge`: `{axis: "vertical" | "horizontal", positionDp, widthDp, occluding}` on the panel it
  folds. `occluding` hinges remove `widthDp` from the layout; a seamless fold has `widthDp: 0`.
- `postures`: for each supported posture, the panel that is active and the hinge angle the web
  view draws, for example `{posture: "half_opened", panel: "inner", hingeDegrees: 90}`.
- `mask`: `rect` (default) or `round`, and `input`: `touch` (default), `dpad` or `rotary`. These
  describe the device, not the renderer's behaviour.

`frame.source` gains a per-field source kind (`publicSpec`, `avdProfile`, `simulatorProfile` or
`measured`) so the registry can mix measured and published values and say which is which.

## Foldables

Book-style foldables (a vertical hinge across a wide inner panel) and flip-style foldables (a
horizontal hinge across a tall inner panel, with a small cover screen) differ in which panel a
posture lights and how the hinge splits it.

- **What a spec sees.** The active panel's size sets `/device/widthClass`. On Android the posture
  maps to `/device/posture`: `opened` is `flat`, a horizontal `half_opened` is `tabletop`, a
  vertical `half_opened` is `book`. iOS has no posture state, so an iOS frame never sets it. The
  prototype contract needs no new signal: `widthClass` and `posture` already exist.
- **Reflow.** The still renderer lays the spec out on the active panel. With an occluding hinge it
  lays out on the panel minus the hinge, as Android reports the display feature; with a seamless
  fold it lays out across the whole panel. `closed` on a book foldable and on a flip renders the
  cover panel.
- **Changing posture** in the page is a fourth view dimension beside variant, revision and
  orientation, so each posture is pre-rendered like an orientation.

## Watches and TVs

- **Watch.** A Wear OS round watch has a `round` mask, which clips the screen to a circle. An
  Apple Watch keeps the `rect` mask with its corner radius. A watch frame has no status bar or
  navigation bar. A Digital Crown or rotary bezel is frame decoration (`input: "rotary"`), not
  behaviour. A watch is `compact` and has no landscape view.
- **TV.** A TV frame has no bezel padding beyond its stand, no status or navigation bar and
  `input: "dpad"`. The renderer marks the first focusable node with a focus ring, because a
  10-foot UI with no focus is not a usable preview. A TV is landscape only.

## Cars

A car frame is a landscape panel with the system bars the head unit draws. A frame is enough for
the still view; driving restrictions (#14922) are device behaviour the web page does not
simulate, so a car frame never hides content.

## Initial frames

The first v2 entries match the hardware profiles AutoMobile already provisions, so a frame's
geometry can be measured on the same emulator or simulator a session runs on.

| Frame               | Platform | Form factor    | Postures (active panel)                                               | Geometry source                                             |
| ------------------- | -------- | -------------- | --------------------------------------------------------------------- | ----------------------------------------------------------- |
| Pixel Fold          | Android  | foldable, book | `closed` (cover), `half_opened` (inner, `book`), `opened` (inner)     | `pixel_fold` hardware profile, the default foldable profile |
| Flip foldable       | Android  | foldable, flip | `closed` (cover), `half_opened` (inner, `tabletop`), `opened` (inner) | the SDK's horizontal-fold foldable profile                  |
| Wear OS small round | Android  | watch          | none                                                                  | `wearos_small_round`, the default watch profile             |
| Apple Watch         | iOS      | watch          | none                                                                  | the simulator device type                                   |
| Android TV 1080p    | Android  | tv             | none                                                                  | `tv_1080p`, the default TV profile                          |
| Apple TV            | iOS      | tv             | none                                                                  | the simulator device type                                   |
| Car 1024p landscape | Android  | automotive     | none                                                                  | `automotive_1024p_landscape`, the default car profile       |

`rear_display`, `flipped` and `tent` are left out until a frame's device supports them. The
existing phone and tablet frames stay v1 entries.

## Where geometry comes from

Each value records its source. In order of preference: a measurement on an emulator or simulator,
the Android SDK hardware profile (`avdmanager list device`) or the simulator device type
(`simctl list devicetypes`, whose profile records the screen size and scale), then a public
specification. A value nobody has measured says so in its source.

## Testing

Snapshots stay bounded by testing each dimension once rather than their product:

- every frame in its default posture, portrait and landscape where the form factor rotates;
- every posture of each foldable in portrait;
- one reference spec per form factor in the CI browser check.

A unit test asserts that each `postures` entry names a panel the frame has and that a hinge lies
on its panel, as v1 already does for cutouts and safe areas.
