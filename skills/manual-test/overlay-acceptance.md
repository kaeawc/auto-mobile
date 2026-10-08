# Overlay (`prototype`) device acceptance recipe

Run from the manual-test skill (Phase 3) whenever the range touches
`src/features/overlay/**`, `src/server/overlayTools.ts`, `hierarchyLayer.ts` or the
CtrlProxy overlay host. Epic #9295, acceptance issue #9309. Android only; use the
Playground app with CtrlProxy built from source. Run on the newest API AVD, and on an
API 30 AVD and the Pixel Fold AVD when the lab has them. Record PASS/FAIL per step with the
ground truth named below; file a bug for each FAIL and link it to #9295.

## Setup

1. Build daemon (`bun run build`), CtrlProxy (`./gradlew :control-proxy:assembleDebug`) and
   Playground (`:playground:app:assembleDebug`, the standard output path) from the worktree.
2. Private daemon per Phase 2 (own data/log/db/coordination/aux dirs, `--port` and
   `--strict-port`, `AUTOMOBILE_CTRL_PROXY_APK_PATH` = the fresh APK, private adb server).
3. Use ONE persistent MCP connection (a session idle for about 2 minutes is released with
   `replay-lease-expired`; overlays with `persistence: "session"` die with it). Mint it with
   `getAndroid { deviceId, enableTools: ["prototype"] }`.
4. Install Playground, `launchApp`, tap Skip then Continue as Guest to reach the Discover screen.
5. Overlay-window ground truth:
   `adb shell dumpsys window windows | grep -c "package=dev.jasonpearson.automobile.ctrlproxy appop=CREATE_ACCESSIBILITY_OVERLAY"`
   (`layer: app` overlays show `appop=SYSTEM_ALERT_WINDOW` and the title
   `AutoMobile Interactive Overlay`). `adb exec-out screencap -p` is the composited truth;
   compare it with the `observe` screenshot.
6. Overlay assets: four tiny PNGs, passed as `assets: [{id, path}]` on `show`.

`showVariants` and `update` no longer exist (#10489, #10490): present variants as one `show`
whose `pager` holds each design (a `tabBar` bound to the pager), with a Select `button` per
page that `emit`s `{index}`.

## Steps

| #   | Do                                                                                                                                                                                                                                                                                                                                              | Expect (ground truth)                                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `observe` with no overlay; save the screenshot                                                                                                                                                                                                                                                                                                  | Hierarchy has no ctrlproxy window; screenshot is the bare app                                                                                                                                                                 |
| 2   | `show` fullscreen, 4-page pager + tabBar, `{type:image}` per page, Select button emitting `{index:N}`. `swipeOn {direction:left, layer:overlay}` (no container) three times, then `tapOn {text:"Select C", layer:overlay}`, then `awaitEvent {id, kind:emit}`                                                                                   | Page text `Variant X page n of 4` advances each swipe; event payload `{index:2}`, `pages.pg == 2`. Also check adb `input swipe` flips the page                                                                                |
| 3   | `show` floating (`gravity`, `offset`) card with a button. `tapOn` an app element with `layer:app`, `swipeOn {direction:up}` on a scrollable app screen (Text tab), `tapOn` the overlay button                                                                                                                                                   | App tab changes and app scrolls; overlay button emits. Window bounds equal the floating card only                                                                                                                             |
| 4   | `show` one spec using every node type (box row column text image icon spacer textField switch checkbox button radioGroup listItem slider chip card scroll pager tabBar bottomNav bottomSheet) and a `theme` (mode, seed, typography, shapes) and every action (emit setPage setState dismiss). Tap each control by testTag with `layer:overlay` | `prototype status` `state`/`pages` reflect every change; `dismiss` action removes the window. Dismiss the IME (`pressButton back`) before tapping controls below it: tapOn correctly refuses a target covered by the keyboard |
| 5   | `observe {project:"full"}` with `layer` omitted / `app` / `overlay`, with overlay text that also exists in the app                                                                                                                                                                                                                              | Omitted: both, overlay first. `app`: no overlay nodes. `overlay`: overlay nodes only. KNOWN GAP: the settled screenshot with `layer:app` still contains the overlay (layer scopes the hierarchy only)                         |
| 6   | `tapOn {text}` for a string in both layers; then with `layer:app`. `sendKeys {commands:[{action:type,text,operation:replace}], selector:{testTag}, layer:overlay}` into an overlay textField                                                                                                                                                    | Default hits the overlay (`ov_*` id, 2 matches index 0, event emitted); `layer:app` hits the app. State key holds the typed text                                                                                              |
| 7   | Kill the daemon and the MCP client with an overlay showing                                                                                                                                                                                                                                                                                      | Overlay window count drops to 0 within 5 s                                                                                                                                                                                    |
| 8   | On the pager (page C), `rotate landscape`, observe, `rotate portrait`                                                                                                                                                                                                                                                                           | Page text still `Variant C page 3 of 4` in both orientations                                                                                                                                                                  |
| 9   | `show` a 300 dp red box with `window.opacity: 50` over the app; `observe` screenshot AND `adb screencap`                                                                                                                                                                                                                                        | Both show red tinted app content (the accessibility overlay window is captured by the observe screenshot). Record per API level                                                                                               |
| 10  | `show` a box with `anchor: {type:element, selector:{testTag}, alignment:cover}` and 50 % opacity on a device with a top cutout                                                                                                                                                                                                                  | Overlay node bounds equal the target element bounds exactly (blocked on #9316 until anchors resolve)                                                                                                                          |

## Related device checks (same session)

- Layer `app`: `window.layer: "app"`; window title `AutoMobile Interactive Overlay` with
  `appop=SYSTEM_ALERT_WINDOW`; swipe and tap still work; `cmd statusbar expand-notifications`
  draws the shade over it.
- Same-id `show` keeps the pager page; `reset: true` returns to page 1.
- `persistence: "device"` (#10494): show, then stop the daemon, MCP client and the private adb
  server. After more than 2 minutes the overlay window is still present and an
  `adb input tap` on its button works. Restart the daemon, `prototype inspect` adopts it
  (`adopted: true, persistent: true`) and `awaitEvent` delivers the buffered emit with its
  original device timestamp.
- Rows under overlays (#10758): with a floating translucent overlay fully covering app buttons,
  the default skeleton `observe` omits those rows and keeps partly exposed ones; `tapOn` on a
  covered row (with or without `layer:app`) is refused naming the covering overlay.
  `project:"full"` is the unprojected hierarchy and still lists the rows with `click`.
- Swipe scoping (#9300, #10752): `swipeOn` with no `layer` scrolls the app under a floating
  overlay; with `layer:overlay` it drives the pager. A `container` scope uses that element's
  bounds, so a swipe inside a page child narrower than the pager can fall below the pager's
  fling threshold; prefer no container.

## Cleanup

`adb -P <port> emu kill`, delete the AVD you created, stop only the daemon/driver PIDs you
started.
