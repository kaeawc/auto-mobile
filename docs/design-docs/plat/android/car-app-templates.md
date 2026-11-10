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
- **Host reader** (`CarAppTemplateReader`). Runs `adb shell content call --user <u> --method snapshot`
  for the foreground package, validates the document, and turns an enabled one into the
  `carAppTemplates` block on the served `observe` copy, never on the cached observation. The user is
  the observation's when it carries one, otherwise the foreground lookup's; a lookup naming another
  package skips the read instead of falling back to user 0, so a secondary or work-profile app is
  never read as the default user. While the user an app was last read as is still quiet (below), or a
  lookup just failed, no lookup runs; a switch to another user's copy of that package is therefore
  read once that entry expires. Overlapping observations of one app share one read.

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
template structure, so the same screen state gives the same ids on every call. `session<n>` follows
first-record order, so it can change after `disable()` and `enable()`.

## Cost and invariants

- An app without the route costs one failed `content call` per device, user and package every five
  minutes. A route that answers disabled is asked again every thirty seconds. A read that fails
  (timeout, adb error, a payload that is not JSON or fails schema validation, the last logged as a
  warning) is retried after five seconds, so a transient failure does not hide an enabled route for
  five minutes. Expired entries are pruned. An enabled route is asked on every `observe`, bounded by
  a 1.5 s deadline for the foreground lookup and another for the read.
- A non-owner read of a held device makes no provider call.
- When the route does not answer with an enabled document, the payload is unchanged, byte for byte.
- No new permissions. The manifest provider is created at launch and answers `enabled: false`;
  recording stays off until the app calls `enable`.
- The block describes templates the app returned, never what the host rendered or hid (driving
  restrictions, list limits, host-side truncation). The `note` field says so on every block.
- The reader asks only the package in `activeWindow.appId`. During Android Auto projection that is
  `com.google.android.projection.gearhead` (its `GhostActivity`), so a projected app's route is never
  asked, although the app keeps recording and its route answers a direct `content call` with the
  top screen the head unit shows. The projected app is the one whose `CarAppService` Android Auto
  binds (`dumpsys activity services` lists it with client `com.google.android.projection.gearhead`).

## Host-rendered marker

`carAppTemplates` covers only apps that opted in, and reports what they built. Independently of the
SDK, `observe.automotive.hostRenderedUi` marks a foreground screen that the car host drew from
templates. It is derived from the observation itself with no extra device reads, by two signals
measured on API 34 ext9 AAOS (#16744):

- any node `resource-id` starting `com.google.android.apps.automotive.templates.host:id/`, which also
  sets `hostPackage`; the app contributes only container ids (`template_view_surface`,
  `template_view_snapshot`) and nodes carry no package field;
- `activeWindow.activityName == "androidx.car.app.activity.CarAppActivity"`, which alone gives the
  marker without `hostPackage`.

The marker is computed whenever the automotive block is built or its foreground activity refreshed,
and again after reconciliation in case the hierarchy was replaced under the same activity. A stale
marker is removed. Non-automotive observations have no `automotive` block, so they are unchanged.
Action code should test it with `isCarAppHostRendered(result)`, or call `detectCarAppHostRenderedUi`
on an observation that may lack the `automotive` block
(`src/features/observe/automotive/carAppHostRenderedUi.ts`), rather than repeating the signals; the
host ignores the BACK key on these screens (#17498).

## Back on host-rendered templates

The AAOS templates host (`com.google.android.apps.automotive.templates.host`) renders template screens
inside the app's `CarAppActivity` and does not act on BACK, whether sent as a global action or an
`input keyevent` (root cause tracked in #17501). `pressButton` `back` keeps BACK as its first attempt, so
behavior is unchanged wherever BACK works. Only when the press dispatched, the screen did not change, and
the screen is a template host (foreground activity `androidx.car.app.activity.CarAppActivity`, or nodes
with the host's resource-id prefix) does it tap the host's Back affordance in a second observed
interaction: `car_ui_toolbar_nav_icon_container` first, then `primary_header_action`, clickable with
non-empty bounds. The target is re-resolved from that interaction's own pre-tap read, and the tap carries
its `frameContext` and asserts the display fence before sending, so a screen that moved on is not tapped
at stale coordinates. A tap that was dispatched without an acknowledged reply is reported as
`indeterminate_outcome` with `retryable: false`, because it may already have navigated. The result names
the tapped affordance in `backFallback`. Template detection is `detectCarAppHostRenderedUi`, the same
check behind the host-rendered marker. The unit fixtures are trimmed captures from an API 34 AAOS
emulator under `test/fixtures/automotive/car-app-templates/`.
