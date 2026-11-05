# tvOS explore and plan replay

`explore` and `executePlan` accept Apple TV devices. Both drive the app with Siri Remote presses
through the tvOS runner; neither uses touch or the embedded SDK.

## Explore is a focus crawl

`explore` on tvOS runs `TvosExplore`, not the touch explorer. The touch explorer scores and taps
elements by coordinates and learns screens from SDK navigation events; an Apple TV app has
neither touch nor, in general, the SDK.

- **Screen identity** is the `ScreenFingerprint` hash of the runner hierarchy. Focus is not part
  of the fingerprint, so moving focus never creates a screen. A move that scrolls changes the
  hash; that hash is aliased to the screen the move started on.
- **Focus map per screen.** The crawl keeps, per screen, the focus positions it has selected and
  the observed result of each direction from each position. A focus position is the focused
  element's identifier, text, class and bounds.
- **Re-read after every press.** The focus engine remembers the last item per row or column, so
  the result of a move cannot be predicted from geometry (`xcuitest-spike.md`). Every press is
  followed by a hierarchy read, and the observed move overwrites any earlier one.
- **Next step.** Select the focused item if it is unselected. Otherwise breadth-first search the
  known moves for the nearest position that is unselected or has an untried direction and take
  the first move toward it. With nothing left, press `menu` back to the parent; on the first
  screen, stop.
- **Recording.** Each `select` and `menu` press runs while the navigation graph holds the public
  call that replays it (`tapOn` by identifier, else by text, else `pressButton select`;
  `pressButton menu`). The identifier wins because two controls can share a
  label. The screen the press reaches is written with `recordNavigationEvent`; a press that
  reaches no new screen withdraws its call.
- **Termination.** Moves need no budget of their own: every move either tries an untried
  direction or follows a known move toward one, and a landing that contradicts a known move
  overwrites it, so known moves cannot cycle without new information. A new focus position is
  selected at once, so new positions are bounded by `maxInteractions` (`select` and `menu`
  presses); `timeoutMs` bounds wall time. A select that leaves the app is answered with one
  `menu` press; if the app is still not in front the crawl stops.

## Plan replay

`PlanExecutionOrchestrator` admits `tvos`, and the plan schema and `PlanValidator` accept `tvos`
as the plan's platform hint and as a plan device's platform. Steps run through the same tool registry as on other
platforms, so each step passes the per-platform tool gate (`applePlatformToolSupport.ts`): a
step whose tool is not on the tvOS allowlist fails with that tool's refusal. Automatic plan video
is skipped because no tvOS recorder exists.
