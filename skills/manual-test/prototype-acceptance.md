# Prototype device acceptance recipe

Run from the manual-test skill (Phase 3) whenever the range touches
`src/features/prototype/**`, `src/server/prototypeTools.ts`, `hierarchyLayer.ts` or the
CtrlProxy prototype host. Epic #9295, acceptance issue #9309. Android only; use the
Playground app with CtrlProxy built from source. Run on the newest API AVD, and on an
API 30 AVD and the Pixel Fold AVD when the lab has them. Record PASS/FAIL per step with the
ground truth named below; file a bug for each FAIL and link it to #9295.

## Setup

1. Build daemon (`bun run build`), then CtrlProxy and Playground from `android/`
   with `./gradlew :control-proxy:assembleDebug :playground:app:assembleDebug`.
   Use the standard Playground output path from Phase 1.
2. Initialize one private broker daemon per Phase 2 with `init --broker-batch`
   (private data/log/db/coordination/aux dirs, unused port, `--protect` for non-batch
   devices, `AUTOMOBILE_CTRL_PROXY_APK_PATH` = the fresh APK). The harness owns
   `--port`/`--strict-port`; the host ADB server remains shared. Use zero pooling
   (`idlePoolCap: 0`, `reuseCleanDevices: false`), `--max-devices` default 2/hard 4.
3. Acquire an Android client with `proxy1 up --client NAME --expect ready` through
   `boot-gate`, or use `broker1 up`. Keep ONE persistent connection for all steps;
   get the grant from `init.json.session` and the exact native descriptor with
   `proxy1 info --client NAME`. Send calls with `proxy1 call --client NAME`.
   Do not call `getAndroid`/`startDevice`, set an active device, or issue sessionless
   calls in broker mode. Confirm `proxy1 tools --client NAME` advertises `prototype`;
   if unavailable, record BLOCKED rather than falling back to generic acquisition.
   A live owner plus heartbeat holds the broker session beyond the plain idle
   window; session-persistent prototypes end when that execution ends.
4. Install Playground, `launchApp`, tap Skip then Continue as Guest to reach the Discover screen.
5. Prototype-window ground truth:
   `adb -s <serial> shell dumpsys window windows | grep -c "package=dev.jasonpearson.automobile.ctrlproxy appop=CREATE_ACCESSIBILITY_OVERLAY"`
   (`layer: app` prototypes show `appop=SYSTEM_ALERT_WINDOW` and the title
   `AutoMobile Interactive Prototype`). `adb -s <serial> exec-out screencap -p` is the composited truth;
   compare it with the `observe` screenshot. Scope every `adb` command to the
   granted serial with `adb -s <serial>`; do not let default ADB choose another device.
6. Prototype assets: four tiny PNGs, passed as `assets: [{id, path}]` on `show`.

`showVariants` and `update` no longer exist (#10489, #10490): present variants as one `show`
whose `pager` holds each design (a `tabBar` bound to the pager), with a Select `button` per
page that `emit`s `{index}`.

## Steps

| #   | Do                                                                                                                                                                                                                                                                                                                                                | Expect (ground truth)                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `observe` with no prototype; save the screenshot                                                                                                                                                                                                                                                                                                  | Hierarchy has no ctrlproxy window; screenshot is the bare app                                                                                                                                                                 |
| 2   | `show` fullscreen, 4-page pager + tabBar, `{type:image}` per page, Select button emitting `{index:N}`. `swipeOn {direction:left, layer:prototype}` (no container) three times, then `tapOn {text:"Select C", layer:prototype}`, then `awaitEvent {id, kind:emit}`                                                                                 | Page text `Variant X page n of 4` advances each swipe; event payload `{index:2}`, `pages.pg == 2`. Also check adb `input swipe` flips the page                                                                                |
| 3   | `show` floating (`gravity`, `offset`) card with a button. `tapOn` an app element with `layer:app`, `swipeOn {direction:up}` on a scrollable app screen (Text tab), `tapOn` the prototype button                                                                                                                                                   | App tab changes and app scrolls; prototype button emits. Window bounds equal the floating card only                                                                                                                           |
| 4   | `show` one spec using every node type (box row column text image icon spacer textField switch checkbox button radioGroup listItem slider chip card scroll pager tabBar bottomNav bottomSheet) and a `theme` (mode, seed, typography, shapes) and every action (emit setPage setState dismiss). Tap each control by testTag with `layer:prototype` | `prototype status` `state`/`pages` reflect every change; `dismiss` action removes the window. Dismiss the IME (`pressButton back`) before tapping controls below it: tapOn correctly refuses a target covered by the keyboard |
| 5   | `observe {project:"full"}` with `layer` omitted / `app` / `prototype`, with prototype text that also exists in the app                                                                                                                                                                                                                            | Omitted: both, prototype first. `app`: no prototype nodes. `prototype`: prototype nodes only. KNOWN GAP: the settled screenshot with `layer:app` still contains the prototype (layer scopes the hierarchy only)               |
| 6   | `tapOn {text}` for a string in both layers; then with `layer:app`. `sendKeys {commands:[{action:type,text,operation:replace}], selector:{testTag}, layer:prototype}` into a prototype textField                                                                                                                                                   | Default hits the prototype (`ov_*` id, 2 matches index 0, event emitted); `layer:app` hits the app. State key holds the typed text                                                                                            |
| 7   | With a session-persistent prototype showing, end this client via `proxy1 abandon --client NAME`; save evidence before zero-pooling destruction                                                                                                                                                                                                    | Check window dismissal within 5 s while the device is queryable; also verify terminal receipt and native absence. If destruction wins the observation race, dismissal timing is not-verifiable                                |
| 8   | On the pager (page C), `rotate landscape`, observe, `rotate portrait`                                                                                                                                                                                                                                                                             | Page text still `Variant C page 3 of 4` in both orientations                                                                                                                                                                  |
| 9   | `show` a 300 dp red box with `window.opacity: 50` over the app; `observe` screenshot AND `adb screencap`                                                                                                                                                                                                                                          | Both show red tinted app content (the accessibility overlay window is captured by the observe screenshot). Record per API level                                                                                               |
| 10  | `show` a box with `anchor: {type:element, selector:{testTag}, alignment:cover}` and 50 % opacity on a device with a top cutout                                                                                                                                                                                                                    | Prototype node bounds equal the target element bounds exactly (blocked on #9316 until anchors resolve)                                                                                                                        |

Step 7 ends the execution. For steps 8–10, acquire a fresh attempt through the
boot gate after verifying step 7's terminal receipt, cleanup and native absence.
Reinstall/setup Playground and show the pager on page C again; do not reuse the
ended session or assume its device still exists. A standalone private daemon
crash is only `private-daemon.ts stop --batch-dir B --daemon 1 --crash` after
recorded PID/start identity confirmation; use the broker restart scenario for
that lifecycle check.

## Related device checks (same session)

- Layer `app`: `window.layer: "app"`; window title `AutoMobile Interactive Prototype` with
  `appop=SYSTEM_ALERT_WINDOW`; swipe and tap still work; `cmd statusbar expand-notifications`
  draws the shade over it.
- Same-id `show` keeps the pager page; `reset: true` returns to page 1.
- `persistence: "device"` (#10494): device-survival qualification needs a separate
  non-broker private batch. Zero-pooling broker release destroys the device, so
  it cannot prove prototype persistence on the same native device. In that
  separate test, show the prototype, disconnect only the test's own client and
  stop its private daemon (never the shared host ADB server). After more than
  2 minutes the window should still be present and a serial-scoped `adb input tap`
  should work. Restart that private daemon, reacquire that same test-owned device,
  and verify `prototype inspect` adopts it (`adopted: true, persistent: true`)
  and `awaitEvent` delivers the buffered emit with its original timestamp.
  Report BLOCKED if a safely isolated same-device setup is unavailable.
- Rows under prototypes (#10758): with a floating translucent prototype fully covering app buttons,
  the default skeleton `observe` omits those rows and keeps partly exposed ones; `tapOn` on a
  covered row (with or without `layer:app`) is refused naming the covering prototype.
  `project:"full"` is the unprojected hierarchy and still lists the rows with `click`.
- Swipe scoping (#9300, #10752): `swipeOn` with no `layer` scrolls the app under a floating
  prototype; with `layer:prototype` it drives the pager. A `container` scope uses that element's
  bounds, so a swipe inside a page child narrower than the pager can fall below the pager's
  fling threshold; prefer no container.

## Cleanup

Run `proxy1 release --client NAME` then `proxy1 close --client NAME`, or
`broker1 down` for the batch. Verify released receipts with `cleanupPending: false`
and native absence recorded in `evidence/ledger.jsonl`; save `broker1 report`
before stopping the private daemon and the batch's recorded caffeinate PID.
The product owns destruction; never delete AVDs/simulators/directories, signal
device processes, pass `force`, or use `adb emu kill`. Protection wins even for a
broker-looking name; only ledger-bound devices are allowed. The separate plain
persistence test uses the harness's provenance-checked `shutdown-devices` before
private daemon stop. Destruction/handoff resource samples remain `not-verifiable`
until a product read-only diagnostic exists; do not turn that limit into PASS.
See the [broker harness](../../docs/using/manual-test-harness.md) and
[broker lifecycle contract](../../docs/design-docs/session-broker-experiment.md).
