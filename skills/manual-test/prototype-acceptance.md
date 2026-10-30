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
5. Prototype-window ground truth: count window lines with the title prefix `AutoMobile Prototype:`:
   `adb -s <serial> shell dumpsys window windows | grep -cF "AutoMobile Prototype:"`
   (`layer: app` prototypes show `appop=SYSTEM_ALERT_WINDOW` and the title
   `AutoMobile Prototype:<id>`). `adb -s <serial> exec-out screencap -p` is the composited truth;
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

- Layer `app`: `window.layer: "app"`; window title `AutoMobile Prototype:<id>` with
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

## Data, storage and network (#12531)

Run on an Android emulator (Playground) and on an iOS simulator (an app launched with
`launchApp prototype: true`); record PASS/FAIL per platform. Design: the "Data, storage and network"
sections of `docs/design-docs/plat/android/prototype-ux.md` and `docs/design-docs/plat/ios/prototype-agent.md`.

**Fixture.** Start the local server on the host and keep it running:
`bun scripts/manual-test/prototype-request-fixture.ts 8787`. It serves `GET /items` (two seed items),
`POST /items` (`{"name"}` appends and returns the item), `GET /fail` (500 with a 400 KB body) and
`GET /reset` (restore seeds). Its stdout logs every request, which is the ground truth for which
transport reached the host.

**Spec.** One screen, id `req-acceptance`, state `{"status":"idle","name":""}`, data `{"items":[]}`,
`storage {"version":1,"keys":["state:name","data:/items"]}`:

- a `textField` bound to `name`;
- a `column` with `repeat {items:{path:"/items/items"}, as:"row"}` of `text` `{row.name}` plus a
  `button` "Remove {row.name}" with `onTap [removeData /data/items/items/{index}]`;
- `text` `{status}` and `text` `{data:/items__meta/error/message}`;
- buttons: **Load** `[request GET http://localhost:8787/items, into /data/items, statusKey status]`;
  **Add** `[request POST http://localhost:8787/items, body {state:name}-wrapped as {"name": ...},
  into /data/added, statusKey status, onSuccess [appendData /data/items/items {data:/added}]]`;
  **Fail** `[request GET http://localhost:8787/fail, into /data/failed, statusKey status]`.

Run the whole table once with `via: "host"` (the default) and once with `via: "device"` on every
request. For Android `via: "device"` the host must have created `adb reverse` for port 8787.

| #   | Do                                                                                                                            | Expect (ground truth)                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `show` the spec; `prototype inspect`                                                                                          | Shown; `inspect` lists `storage` for the id (no keys yet). Android `via:"device"`: show result has no `reverseFailures`, and `adb -s <serial> reverse --list` contains `tcp:8787`     |
| 2   | Tap **Load**; `awaitEvent kind:emit eventName:prototype_request`                                                              | Status went `loading` then `success`; two rows `alpha`, `beta`; fixture log `GET /items 200`; event payload `via` matches the transport, `outcome:"success"`, `status:200`            |
| 3   | Type `gamma` in the field, tap **Add**                                                                                        | Fixture log `POST /items 201`; status `success`; a `gamma` row appears (appendData ran from `onSuccess`); a `change` event named `/data/items/items` with `op:"append"`               |
| 4   | Tap **Remove beta**                                                                                                           | The `beta` row disappears; `change` event `op:"remove"`; `prototype status` data matches the screen                                                                                   |
| 5   | Tap **Fail**                                                                                                                  | Status `error`; `items__meta`-style metadata for `/data/failed__meta` has `error.code:"http_error"` and `status:500`; `failed` data is not written; the 400 KB body is never an error |
| 6   | Stop the fixture, tap **Load**, restart it                                                                                    | Status `error` with `error.code` `connection_refused` (`via:"host"` or iOS) or `network`; `/data/items` keeps its previous rows                                                       |
| 7   | Tap **Load** twice quickly                                                                                                    | Only the second request's result lands (latest wins); the first reports `cancelled` and the fixture sees one request for the host transport after the cancel                          |
| 8   | `show` the same id again (no `reset`)                                                                                         | Rows and the `name` field are restored from storage (`gamma`, `alpha`), not the spec's empty values; `inspect` `storage.keys` lists `state:name` and `data:/items`                    |
| 9   | Force-stop and relaunch the app (Android: re-show over Playground; iOS: `launchApp prototype:true` again), `show` the same id | Same restored values as step 8 (persisted across processes)                                                                                                                           |
| 10  | Change the spec to `storage.version: 2` and `show`; then `clearStorage {id}` and `show`                                       | Version change discards stored values (spec's empty rows); after `clearStorage` the result reports the removed key count and the next show starts from the spec                       |
| 11  | `GET http://127.0.0.1:8787/reset`; `dismiss` the prototype                                                                    | Window gone; on Android `adb reverse --list` no longer shows `tcp:8787` (removed when the last holder dismisses); an iOS simulator needs no cleanup                                   |

Platform notes to record:

- **localhost.** `via:"host"` reaches the fixture on the host machine from both platforms. For
  `via:"device"`, an Android emulator reaches it only through the automatic `adb reverse`; an iOS
  simulator shares the Mac's loopback. Confirm both by the fixture log.
- **Cleartext / ATS.** `http://localhost:8787` works for `via:"device"` on both (Android permits
  cleartext; iOS ATS exempts localhost). Repeat Load against `http://<mac-lan-ip>:8787/items` on iOS
  with `via:"device"`: if the app's ATS blocks it, expect a `network` error whose message points to
  `via: "host"`; `via:"host"` must still succeed.
- **Saved Android prototype.** Save the spec, launch it from the home screen with no host attached:
  Load with `via:"device"` works (given a reachable URL); with `via:"host"` it fails with an
  `invalid_request` error saying host requests are not available in saved prototypes.

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
See the [broker harness](../../docs/design-docs/manual-test-harness.md) and
[broker lifecycle contract](../../docs/design-docs/session-broker-experiment.md).
