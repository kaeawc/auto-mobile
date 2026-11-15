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
  for the foreground package (or, during Android Auto projection, each bound car app; see below). It
  validates the document and turns an enabled one into the `carAppTemplates` block on the served
  `observe` copy, never on the cached observation. The user is the observation's when it carries
  one, otherwise the foreground lookup's. A lookup naming another package skips the read instead of
  falling back to user 0, so the reader never reads a secondary or work-profile app as the default
  user. No lookup runs while the user an app was last read as is still quiet (below), or a lookup
  just failed. The reader therefore picks up a switch to another user's copy of that package once
  that entry expires. Overlapping observations of one app share one read.

## Stack walk

Screen stacks are main-thread state. The provider runs on a binder thread, so the walk posts to the
main looper and waits at most one second. The posted block copies the recorded templates itself, so
the stacks and the templates reported for them come from one state. A timeout drops the posted block
from the main-thread queue and returns `enabled: true` with `error: "main_thread_timeout"`, never a
partial stack; a main looper that is already gone returns `error: "main_thread_unavailable"`.
Recording is rechecked while the write is held, so a template returned as `disable()` runs is
dropped rather than kept past the clear. Sessions are the distinct `ScreenManager`s of
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
  minutes. The reader asks a route that answers disabled again every thirty seconds. A completed
  Android install attempt clears the package's quiet state and user hint on that device for all
  users, even on failure. If no package name is available, it clears the device's quiet state and
  hints. The next observation asks again without waiting for the TTL.
- The reader retries a failed read after five seconds, so a transient failure does not hide an
  enabled route for five minutes. Failures are a timeout, an adb error, or a payload that is not
  JSON or fails schema validation (the last logged as a warning). The reader prunes expired
  entries. It asks an enabled route on every `observe`, bounded by a 1.5 s deadline for the
  foreground lookup and another for the read.
- A non-owner read of a held device makes no provider call.
- When the route does not answer with an enabled document, the payload is unchanged, byte for byte.
- No new permissions. The manifest provider is created at launch and answers `enabled: false`;
  recording stays off until the app calls `enable`.
- The block describes templates the app returned, never what the host rendered or hid (driving
  restrictions, list limits, host-side truncation). The `note` field says so on every block.
- During Android Auto projection the foreground package is `com.google.android.projection.gearhead`
  (its `GhostActivity`), not the projected app, while the projected app keeps recording. When the
  foreground is gearhead, the reader runs `dumpsys activity services` (about 40 ms and 360 KB on API
  36, under the same 1.5 s deadline). It reuses a successful dump per device for 1 s, so
  back-to-back observations do not re-dump. A head-unit action's before and after
  bindings reads dump fresh, so the after read never reuses the before dump. The reader takes each ServiceRecord whose binding client is a
  gearhead process, excluding gearhead's own services.
- A ServiceRecord block ends only at the next ServiceRecord, an indented section header such as
  `Connection bindings to services:`, or an unindented line. In-record fields such as
  ` startCommandResult=1` sit at indent 1. The bind intent carries no
  `androidx.car.app.CarAppService` action (API 36 shows `intent={id=0/main cmp=<pkg>/<class>}`).
  Maps, media and Play services are therefore candidates too, and the reader keeps only the apps
  whose route answers enabled. The others cost one cached failed call per absent TTL.
- The reader reads each app as the user in its ServiceRecord, with no foreground lookup, through the
  same per-package path. Quiet entries, deadlines and shared in-flight reads apply unchanged. The
  block then has `projectedBy`, `projectedNote` and `projected[]` (package, sessions, error) instead
  of a top-level `packageName`. Android Auto does not say which bound app is on the head unit
  (#17827), so the block lists every enabled app by package name and marks none visible. A failed
  dump, or no bound app answering enabled, leaves the payload unchanged.
- A bound app whose route last answered enabled but whose read fails (or is inside its five-second
  retry interval) stays listed with no sessions and `error: "template_read_failed"`. A head-unit
  action then reads its screen as unknown rather than gone. The reader still drops an app with no
  such answer.
- The reader resolves the `androidAuto` block (#17841) after `carAppTemplates`, from the services
  snapshot that read took for the same observation (kept past the dump's TTL). It costs no extra
  device read. The block appears only while gearhead is the foreground package and one of
  gearhead's `.apphost.Template*Service` hosts has a live gearhead binding. There is one host per
  car app category; the captured dump shows `TemplateNavigationService` bound by `gearhead:car`.
  That binding is positive evidence that a head unit session hosts car app templates.
- The `apps[]` list keeps only bound apps (package and user) whose route answered. Android Auto binds
  Maps, media, Play and Assistant services the same way. Without a captured
  `cmd package query-services -a androidx.car.app.CarAppService` read, an answering route is the
  only proof an app is a Car App Library app. Each entry carries the bound components from the
  dump.
- The block never names a visible app: the bound set and the route's answer stay the same while
  another app is on the head unit (#17827). The host's own state
  (`dumpsys activity service <host>`, `activity state:RESUMED`/`isShowing:true`) does tell
  visibility for a category with a single bound app, but the reader does not read it. The block
  omits head unit config, resolution and screenshot. No projection seen leaves the payload
  unchanged, byte for byte.

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

Observe computes the marker whenever it builds the automotive block or refreshes its foreground
activity. It computes it again after reconciliation in case the hierarchy changed under the same
activity, and removes a stale marker. Non-automotive observations have no `automotive` block, so
they are unchanged.
Action code should test it with `isCarAppHostRendered(result)`, or call `detectCarAppHostRenderedUi`
on an observation that may lack the `automotive` block
(`src/features/observe/automotive/carAppHostRenderedUi.ts`), rather than repeating the signals; the
host ignores the BACK key on these screens (#17498).

## Back on host-rendered templates

The AAOS templates host (`com.google.android.apps.automotive.templates.host`) renders template screens
inside the app's `CarAppActivity` and does not act on BACK, whether sent as a global action or an
`input keyevent` (root cause tracked in #17501). The `pressButton` `back` action keeps BACK as its
first attempt, so behavior is unchanged wherever BACK works.

It falls back only when the press dispatched, the screen did not change, and the screen is a
template host. A template host has foreground activity `androidx.car.app.activity.CarAppActivity`,
or nodes with the host's resource-id prefix. The fallback taps the host's Back affordance in a
second observed interaction: `car_ui_toolbar_nav_icon_container` first, then
`primary_header_action`, clickable with non-empty bounds. It re-resolves the target from that
interaction's own pre-tap read. The tap carries its `frameContext` and asserts the display fence
before sending, so a screen that moved on never gets a tap at stale coordinates.

A tap dispatched without an acknowledged reply reports `indeterminate_outcome` with
`retryable: false`, because it may already have navigated. The result names the tapped affordance
in `backFallback`. Template detection is `detectCarAppHostRenderedUi`, the same check behind the
host-rendered marker. The unit fixtures are trimmed captures from an API 34 AAOS emulator under
`test/fixtures/automotive/car-app-templates/`.

## Background

- [Car App templates: head-unit visibility from host state](../../../devlog/2026-11-11-car-app-templates-host-visibility.md)
