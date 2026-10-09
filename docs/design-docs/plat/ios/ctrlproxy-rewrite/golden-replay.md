# Golden capture and replay for the iOS CtrlProxy

**Issue:** #5837. **Status:** capture and replay are in place, and the nearest-match
tie-break was checked against real hierarchy pairs. Across the corpus the change
alters no merged output.

Unit tests can replay real runner traffic at two layers:

| Layer                | What is recorded                                                              | Switch                                                          | Replayed by                                                                            |
| -------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Host WebSocket       | Every request the TS `IOSCtrlProxyClient` sends and every runner reply        | `AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR` on the host process       | `test/fakes/ReplayCtrlProxyWebSocket.ts`                                               |
| Runner merger inputs | Each `(xcuitest, sdk)` pair `HierarchyMerger` receives on `request_hierarchy` | `CTRL_PROXY_IOS_HIERARCHY_PAIR_DIR` in the runner's environment | `ios/control-proxy/Tests/CtrlProxyRewriteTests/HierarchyMergerGoldenReplayTests.swift` |

## Recording format

**Host exchanges.** `CtrlProxyExchangeRecorder` wraps the client's WebSocket
factory. It writes one pretty-printed JSON file per exchange, numbered in arrival
order:

- `NNNN-<request type>.json` holds `{"request": …, "response": …}`, paired by `requestId`.
- `NNNN-<request type>.json` holds `{"request": …}` for a frame that gets no reply.
- `NNNN-push-<type>.json` holds `{"push": …}` for an unsolicited message, such as
  `connected`, `hierarchy_update` or `performance_update`.

Per owner policy, nothing is redacted except text typed into a password field. The
host never sees which field it types into. So for `request_set_text` and
`request_append_text`, the recorder looks up the target in the latest recorded
hierarchy (by `resourceId`, or else the focused node). It replaces `text` with
`<redacted:password-field>` when that node has `password: "true"` or the target
cannot be found.

**Merger pairs.** `HierarchyPairFileRecorder` writes compact, sorted-key
`{"sdk": SdkViewHierarchy, "xcuitest": ViewHierarchy}` files named
`pair-NNNN-<bundle>.json`. It records only when the runner has an SDK hierarchy for
the foreground app. Simulators share the host filesystem, so the files land
directly in the named host directory. Physical devices are not supported, and the
daemon forwards the variable only to simulator runners. XCUITest already masks
secure-field values, and the SDK tree carries labels and geometry rather than field
contents, so nothing is redacted.

## Capturing or refreshing

Use a simulator you create for the purpose. The committed corpus came from an
iPhone 17 on iOS 26.5 (Xcode 26.6).

1. Build the runner from your checkout:
   `AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA=/tmp/golden/dd bash scripts/ios/ctrl-proxy-build-for-testing.sh`.
2. Copy the generated `.xctestrun` and add these keys under
   `CtrlProxyUITests.EnvironmentVariables`: `CTRL_PROXY_IOS_PORT` (for example
   `8791`), `AUTOMOBILE_DEVICE_ID` (the simulator UDID) and
   `CTRL_PROXY_IOS_HIERARCHY_PAIR_DIR` (the pair output directory). Then start the
   runner:
   `xcodebuild test-without-building -xctestrun <copy> -destination "platform=iOS Simulator,id=<udid>" -only-testing:CtrlProxyUITests/CtrlProxyUITests/testRunService`.
3. Drive it with `scripts/ios/capture-ctrlproxy-golden.ts`, which talks to the
   runner directly with no daemon:
   ```bash
   # Host exchanges: launch Settings, observe, tap "General", observe.
   AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR=/tmp/golden/settings \
     bun scripts/ios/capture-ctrlproxy-golden.ts --udid <udid> --port 8791 \
     --bundle com.apple.Preferences --tap General
   # Merger pairs: one fresh pair per Playground tab, and per demo screen.
   SIMCTL_CHILD_PLAYGROUND_INITIAL_TAB=demos AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR=/tmp/golden/x \
     bun scripts/ios/capture-ctrlproxy-golden.ts --udid <udid> --port 8791 \
     --bundle dev.jasonpearson.automobile.Playground --fresh --tap "Scroll Performance"
   ```
4. Copy the results to `test/fixtures/ios/ctrlproxy-golden/<scenario>/` (host
   exchanges, unmodified) or `test/fixtures/ios/merger-pairs/<name>.json` (pairs).
   Re-run both replay suites, then update the expected values in
   `HierarchyMergerGoldenReplayTests` and the results below. Every fixture
   directory is pinned `text eol=lf` in `.gitattributes`.

With a daemon, set `AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR` and
`CTRL_PROXY_IOS_HIERARCHY_PAIR_DIR` on the daemon process. The client then records
everything that daemon's tools send, and the daemon forwards the pair directory
into the simulator runner's xctestrun environment. Isolate a private daemon fully
first; see `docs/using/environment-variables.md`.

## Committed corpus

- `test/fixtures/ios/ctrlproxy-golden/settings-tap-general/` holds 14 exchanges:
  `request_launch_app`, two `get_sdk_capabilities`, `request_hierarchy_if_stale`
  on the Settings root, `request_tap_coordinates` at the General row's centre
  (201, 406), `request_hierarchy_if_stale` on the General screen, and the pushes in
  between. `test/features/observe/ios/IOSCtrlProxyClientGoldenReplay.test.ts`
  replays them through a real `IOSCtrlProxyClient`.
- `test/fixtures/ios/merger-pairs/` holds seven Playground pairs: the four tabs
  (`--fresh` launch into each) and the SDK Status, Scroll Performance and
  Animations demo screens (`--fresh --tap`). The Playground binary was a Debug
  simulator build of main from 2026-09-28. A fresh build was blocked locally by a
  missing Metal toolchain. The merger only consumes the SDK tree's wire shape, so
  the build date does not affect the result.

## Nearest-match tie-break results

`HierarchyMerger.ToleranceTieBreak.legacyDeltaLoopOrder` reproduces the
pre-#8662 probe. Exact bounds are tried first. Then the first `(dl, dt, dr, db)` in
ascending nested-loop order wins, where each key is represented by its
first-inserted node, and a representative that fails the identifier check makes
that key a miss. The replay merges every pair both ways and compares every output
node's own fields.

| Fixture                 | XCUITest nodes with bounds | Exact SDK bounds | Within ±2 only | …at ≥2 distinct bounds | Output differences |
| ----------------------- | -------------------------: | ---------------: | -------------: | ---------------------: | -----------------: |
| tab-discover            |                         46 |               23 |             10 |                      0 |                  0 |
| tab-demos               |                         69 |               31 |             14 |                      0 |                  0 |
| tab-files               |                         14 |                7 |              3 |                      0 |                  0 |
| tab-settings            |                         52 |               32 |             11 |                      0 |                  0 |
| demo-sdk-status         |                         45 |               28 |              5 |                      0 |                  0 |
| demo-scroll-performance |                         46 |               21 |              3 |                      1 |                  0 |
| demo-animations         |                         20 |               10 |              4 |                      0 |                  0 |
| **Total**               |                    **292** |          **152** |         **50** |                  **1** |              **0** |

The two orders can disagree only for a query that has SDK candidates at two or more
distinct bounds within tolerance. Same-bounds candidates resolve to the first node
in document order either way. The corpus has one such query: the Scroll
Performance navigation title (`UILabel` at `[124, 73, 277, 94]`). Its candidates
are three wrappers at `[125, 74, 278, 95]` and one `UILabel` at
`[125, 74, 277, 95]`. The exact-class pass sees only the `UILabel`, so both orders
pick it. In all 50 tolerance-only queries the nearest SDK candidate is exactly
1 pt away, which is consistent with the same frame rounded differently. In practice the nearest-match change is a no-op on real Playground
hierarchies. It matters only for synthetic layouts where differently sized views
sit within 2 pt of an element, as `HierarchyMergerToleranceMatchTests` shows.

`testCorpusToleranceCoverageIsAsDocumented` pins the coverage columns, so an empty
diff cannot pass vacuously. Making the legacy matcher always miss turns
`testRealPairsDifferOnlyWhereDocumented` red.

## Known differences between replay and a live runner

- **Matching is by type and order, not by payload.** A replayed request gets the
  next unused recorded response of the same `type`, with the live `requestId`
  substituted. Coordinates, timeouts and frame contexts are not compared; tests
  assert on `sentRequests` when they matter. A request with no recorded response
  left goes into `unmatchedRequests` and gets no reply.
- **Pushes are not replayed, except `connected`.** The handshake is replayed when
  the socket opens. Recorded `hierarchy_update` and `performance_update` pushes are
  kept in the fixture but never emitted on their own.
- **Recorded timing.** `perfTiming`, `timestamp` and `updatedAt` are capture-time
  values, and replies arrive on the next microtask with no latency.
- **Redaction.** Replayed text-input requests carry `<redacted:password-field>`
  wherever the recorder redacted them.
- **The runner's SDK cache.** On `request_hierarchy`, the runner probes the SDK only
  while it has no cached tree for the foreground app. After that it reuses the
  cache until the app posts `/sdk-events`. During this capture no events arrived
  after an in-app tap, so pairs recorded right after a tap paired the new XCUITest
  screen with the previous screen's SDK tree. `--fresh` clears the cache: it
  requests a SpringBoard hierarchy before each capture, after terminating the app
  or (after a tap) going Home, then relaunches. Every committed pair has an SDK
  timestamp later than the screen change.
- **Switching apps outside the runner.** After `simctl launch` alone, the runner
  reported the new app's hierarchy, but taps still targeted the previous app and
  failed with `Application … is not running`. The capture script therefore follows
  every `simctl launch` with `request_launch_app`, which activates the app and
  retargets the runner. The daemon's `launchApp` tool already takes this path.
