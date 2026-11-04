# Car App Library template snapshots

`observe` can report the Car App Library (`androidx.car.app`) template stacks of an app that integrates
the AutoMobile Android SDK. It is the Android counterpart of the CarPlay SDK route. The agent checks
template content without a head unit or the Desktop Head Unit.

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
