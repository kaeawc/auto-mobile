# Car App Library template snapshots

`observe` can report the Car App Library (`androidx.car.app`) template stacks of an app that integrates
the AutoMobile Android SDK. It is the Android counterpart of the CarPlay SDK route. The agent checks
template content without a head unit or the Desktop Head Unit.

## App setup

The app turns the route on once in a debug build and passes each template through `record` as
`onGetTemplate` returns it:

```kotlin
// Once, e.g. in your CarAppService or Session.
AutoMobileCarAppTemplates.enable(context)

override fun onGetTemplate(): Template =
  AutoMobileCarAppTemplates.record(this, ListTemplate.Builder() /* ... */.build())
```

`enable` returns `false` and does nothing in a non-debuggable build.

## Pieces

- **Recorder** (`AutoMobileCarAppTemplates`, SDK main source set). The library keeps the template a
  screen last built private, and calling `onGetTemplate` again would run app code, so the app passes
  each template through `record(screen, template)`. Recording is off until `enable(context)`, which
  refuses non-debuggable apps. While off, `record` only returns its argument. Screens and their
  `ScreenManager`s are weak keys, so a finished screen or session is never retained.
- **Mapper**. Pure: it turns an immutable `Template` into a node and never touches a screen or the
  host. Known types get typed fields. Any other type keeps its class name with no fields.
- **Route** (`CarAppTemplateRoute`, car-free). The SDK declares the Car App Library `compileOnly`, so
  the debug provider must not load a car class. It reads a source the recorder installs and answers
  `enabled: false` when there is none.
- **Provider** (`CarAppTemplatesProvider`, debug source set only, authority
  `<applicationId>.automobile.carapptemplates`). Read-only; every entry point enforces
  `DebugInspectorAccess` (shell, root, own uid, CtrlProxy).
- **Host reader** (`CarAppTemplateReader`). Runs `adb shell content call --method snapshot` for the
  foreground package, validates the document, and turns an enabled one into the `carAppTemplates`
  block on the served `observe` copy, never on the cached observation.

## Stack walk

Screen stacks are main-thread state. The provider runs on a binder thread, so the walk posts to the
main looper and waits at most one second. A timeout returns `enabled: true` with
`error: "main_thread_timeout"`, never a partial stack. Sessions are the distinct `ScreenManager`s of
recorded screens. Each is numbered in first-record order and dropped when its stack is empty.
`ScreenManager.getScreenStack()` iterates from the top down, and the snapshot reverses it so the root
comes first.

## Ids

Ids are slash paths: `session<n>/screen<i>/template/...`, then `items/<k>` (or
`sections/<s>/items/<k>`), `header/actions/<k>`, `actions/<k>`, `actionStrip/actions/<k>`,
`mapActionStrip/actions/<k>`, `tabs/<k>` and `tabContent/...`. They depend only on stack position and
template structure, so the same screen state gives the same ids on every call.

## Cost and invariants

- An app without the route costs one failed `content call` per device, user and package every five
  minutes. A route that answers disabled is asked again every thirty seconds. An enabled route is
  asked on every `observe`, bounded by a 1.5 s deadline.
- A non-owner read of a held device makes no provider call.
- When the route does not answer with an enabled document, the payload is unchanged, byte for byte.
- No new permissions. Nothing runs in the app until it calls `enable`.
- The block describes templates the app returned, never what the host rendered or hid (driving
  restrictions, list limits, host-side truncation). The `note` field says so on every block.

## Back on host-rendered templates

The AAOS templates host (`com.google.android.apps.automotive.templates.host`) renders template screens
inside the app's `CarAppActivity` and does not act on BACK, whether sent as a global action or an
`input keyevent` (root cause tracked in #17501). `pressButton` `back` keeps BACK as its first attempt, so
behavior is unchanged wherever BACK works. Only when the press dispatched, the screen did not change, and
the screen is a template host (foreground activity `androidx.car.app.activity.CarAppActivity`, or nodes
with the host's resource-id prefix) does it tap the host's Back affordance in a second observed
interaction: `car_ui_toolbar_nav_icon_container` first, then `primary_header_action`, clickable with
non-empty bounds. The result names the tapped affordance in `backFallback`. Template detection is a local
check in `src/features/action/carAppTemplateBack.ts`; it should switch to observe's host-rendered marker
(#17499) once that exists. The unit fixtures are trimmed captures from an API 34 AAOS emulator under
`test/fixtures/automotive/car-app-templates/`.
