# Prototype performance measurement

## Compose compiler reports

From the repository root, run:

```bash
scripts/android/compose-compiler-report.sh
```

The script compiles `:control-proxy:compileReleaseKotlin --rerun` with
`-Pautomobile.composeCompilerReports=true`. Only the exact property value `true`
enables compiler reports and metrics; normal builds do not configure their
output destinations. The rerun forces compiler execution even with cached outputs.
The reports land in the `compose-compiler-reports` directory of the control-proxy
module's Gradle build output: `control-proxy-composables.txt` is at its root and the
module metrics are in `release/control-proxy-module.json`. The property alone does not
force a recompile, so an up-to-date or cached compile writes nothing.

To summarize existing reports without Gradle, use `--reports-dir DIR`. Use
`--package PREFIX` to select fully qualified function names starting with
`PREFIX.` (default: `dev.jasonpearson.automobile.ctrlproxy.prototype`). Use
`--write-doc docs/design-docs/plat/android/prototype-compose-compiler-report.md`
to overwrite the [generated Compose compiler report](prototype-compose-compiler-report.md)
page; stdout still contains the same deterministic summary.

The totals count listed functions, including value-returning helpers and overloads.
The table sorts simple function names, preserving report order for overloads.
Restartable means Compose can independently restart the function; skippable means
it can skip a call when its arguments have not changed. Unstable parameters list
explicit `unstable` markers; the final column lists parameters with no compiler
stability marker. Stable parameters are omitted, and `—` means none. Default-value
annotations are removed. The module-wide line reports counts for the entire module,
not just the selected package.

With strong skipping on (`featureFlags.StrongSkipping = true`), every restartable
composable is skippable, so the useful signal is the unstable and unmarked parameters,
which are compared by instance identity rather than `equals` when unstable at runtime.
The captured module aggregate has different totals from this package listing;
compare the same report scope across measurements.

## Frame-time benchmark

Prerequisites: a connected Android device explicitly selected by ID, a compatible
CtrlProxy with its accessibility service enabled, `adb`, `bun`, `jq`, and an already
running AutoMobile daemon. The script never starts or configures a daemon. If the
device belongs to a session, export its `AUTOMOBILE_SESSION_UUID`; the script passes
it as `--session-uuid` on every CLI call. Measure a release-like build; debug numbers
are only comparable with debug numbers (see #12129).

```bash
scripts/android/prototype-frame-benchmark.sh --device DEVICE_ID
scripts/android/prototype-frame-benchmark.sh --list
scripts/android/prototype-frame-benchmark.sh --dry-run --device DEVICE_ID
scripts/android/prototype-frame-benchmark.sh --device DEVICE_ID --scenario tab-switch --markdown
```

The fixed fullscreen spec is `benchmark/prototype-frame/spec.json`, ID
`perf-benchmark`. It expands to approximately 900 mapped nodes, including hidden
subtrees, 150 list rows, 30 images, four state-selected tab bodies, four pager pages,
and more than 70 visibility conditions. Individual repeats stay within the 128-item
contract limit. The pager, controls, tab body, and collapsing section have bounded
regions so the long list can scroll without moving the scenario controls offscreen.

The image contract requires asset IDs. The 30 nodes reference `benchmark-image`;
missing assets render placeholders. The owed asset step is to upload a representative
PNG/JPEG/WebP as `benchmark-image` through `prototype`'s `assets` argument before
recording an image-decoding baseline. The default script measures placeholders and
must be labelled that way; it does not push assets.

`benchmark/prototype-frame/scenarios.json` is the single source of truth. Each entry
has `name`, `description`, `repeat`, `settleMs`, and `steps`; idle additionally has
`durationMs`. Each step has `tool` and `text`; swipes additionally have `direction`.
The script converts text to a tap `selector` or swipe `container` and explicitly
uses `layer: prototype`. It sleeps after each complete repetition, or for idle's
specified duration. Other steps have no extra sleep between commands.

| Scenario         | Repeats | Steps per repeat                                       | Settle           |
| ---------------- | ------- | ------------------------------------------------------ | ---------------- |
| idle             | 1       | No input; count frames rendered in 3 seconds           | 3000 ms duration |
| tab-switch       | 5       | Tab 2, Tab 3, Tab 4, Tab 1                             | 600 ms           |
| section-collapse | 4       | Toggle section twice (collapse, reopen)                | 600 ms           |
| pager-swipe      | 4       | Swipe Benchmark pager left, right                      | 600 ms           |
| scroll           | 4       | Swipe Benchmark list up, down                          | 600 ms           |
| overlay-open     | 1       | Open overlay, Close overlay                            | 600 ms           |
| three-write-tap  | 5       | three-write tap (three independent counter increments) | 600 ms           |

The script shows the spec once and waits `--show-settle-ms N` (default 2000 ms)
for initial composition before the first reset. N must be a non-negative integer;
0 skips this wait. It resets `dumpsys gfxinfo` before each scenario, captures it
afterward, and always attempts to dismiss this prototype on exit.
Plain output is exactly one line per scenario:

```text
scenario=tab-switch frames=100 janky_pct=5.00 p50_ms=8 p90_ms=12 p95_ms=16 p99_ms=22 slow_ui=1
scenario=idle error=missing-fields
```

Percentiles and slow UI counts come directly from gfxinfo. Capture failures or
missing fields produce an error line, continue with remaining scenarios, and exit 1.
An idle dump with no percentile fields reports an error rather than inventing
zero latency; its acceptance metric remains the actual frames rendered in 3 seconds.
`--markdown` prints a table with the same fields and an error column. `--scenario`
is repeatable; selected scenarios retain file order. `--package`, `--spec`, and
`--scenarios` override defaults. `--device` is mandatory except for `--list` and
`--dry-run`; dry-run prints every command, including sleep and cleanup, and runs none.
`PROTOTYPE_BENCH_ADB` and `PROTOTYPE_BENCH_CLI` accept executable paths, such as private
CLI wrappers; the default CLI is `bun <repo>/src/index.ts --cli`.

Baseline: not yet recorded on a device.

### Feed benchmark

The feed driver reuses the gfxinfo harness with a deterministic fullscreen `perf-feed`
lazy list (1,000 rows by default, up to the contract cap of 2,000). It needs the same
Android prerequisites and an existing daemon/session. Measure a release-like build
on API 37; the target is **p95 < 16 ms** per scenario.

```bash
scripts/android/prototype-feed-benchmark.sh --device DEVICE_ID --rows 1000 --markdown
scripts/android/prototype-feed-benchmark.sh --device DEVICE_ID --enforce
scripts/android/prototype-feed-benchmark.sh --dry-run
bun scripts/prototype/generate-feed-benchmark-spec.ts --rows 1000 --out /tmp/feed.json
bun scripts/prototype/generate-feed-benchmark-spec.ts --rows 1000 --paging --page-url http://localhost:8080/page --out /tmp/paged-feed.json
scripts/ios/prototype-feed-benchmark.sh --device SIMULATOR_UDID --rows 1000 --swipes 6
```

`feed-scenarios.json` defines `feed-idle` (three seconds without input),
`feed-scroll-down` (two up/up/down/down repetitions), and `feed-fling-roundtrip`
(three consecutive up swipes then three down). The latter uses ordinary `swipeOn`
commands: the harness has no velocity setting and does not guarantee a physical fling.
There are 14 swipe calls and 4.8 seconds of scenario waits, plus the initial two-second
settle; the intended run budget is under three minutes with a responsive CLI/device.
The `Benchmark feed` content description selects the list container.

The Android wrapper prints the harness plain output, an optional Markdown verdict
table, and a `verdict` line per scenario. A numeric p95 of 16 ms or higher fails;
zero-frame or unavailable percentiles are `n/a`. The default reports timing failures;
`--enforce` makes them exit nonzero. Harness capture/CLI errors always retain their
nonzero status. `--package` selects the gfxinfo package, and
`PROTOTYPE_FEED_BENCH_FRAME` overrides the harness executable for offline testing.

Rows contain a local-asset avatar, author, caption, counters and a Like state action.
The harness supplies the tiny `benchmark-image` PNG. This measures placeholder/local-asset
rows, not remote-image loading or representative image decoding (remote images are
unavailable, #14181). The default spec has no network actions. `--paging` requires
an HTTP(S) `--page-url` reachable from the device; the fixture response is
`{"items":[...]}` with the same row fields and globally unique IDs. `request.append`
extends `/data/feed/items`; the bounded list trims oldest rows at the contract cap.
Use fresh IDs and an empty final page to stop end-triggered loading. This optional
fixture variant needs a separate show/scroll acceptance run; the wrapper measures
the pure-scroll variant.

The iOS driver shows the same spec, uses placeholder avatars, scrolls up for the first
half of the calls and down for the rest, then dismisses it. It requires an already
available compatible prototype host and daemon, accepts `PROTOTYPE_BENCH_CLI`, and
forwards `AUTOMOBILE_SESSION_UUID`. It reports elapsed wall-clock milliseconds for
each CLI swipe step and for the scroll loop, including CLI/transport overhead and
excluding show/dismiss. These are **not frame times**; simulators expose no gfxinfo.
`--swipes` accepts 1–100 (default 6); `--dry-run` prints commands without executing them.

Feed baseline (2026-10-26, 1,000 rows, debug CtrlProxy on an API 37 arm64 emulator with
software rendering, host load average above 140): `feed-scroll-down` p95 250 ms and
`feed-fling-roundtrip` p95 300 ms (about 98% janky), `feed-idle` no frames. This is a
smoke baseline, not a verdict: it misses the 16 ms target, but the debug build, software
GL and a saturated host dominate it. Re-measure a release build on an idle host or device.
iOS simulator (iPhone 17, iOS 26.5): six scripted swipes took 50.5 s wall time including
CLI overhead, which is not a frame-time measure.

## Trace sections

All nine trace sections below are in the renderer (#12128).
The names are stable so Perfetto queries can be shared between measurements. All sections use the
framework `android.os.Trace` (no new dependency). All sections are emitted only while tracing
is enabled via `Trace.isEnabled` (API 29+); below API 29 none is emitted and no `android.os.Trace`
method is called. The async-section calls also need API 29.

| Section name                   | Insertion point                                                                                                             | Kind                                                                         | Status      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------- |
| `Prototype.interact`           | `PrototypeController.interact`, inside `mutex.withLock`, from after the stale-runtime check to the end                      | Async section (the body suspends and may resume on another thread)           | in renderer |
| `Prototype.validateStateWrite` | `PrototypeRuntime.validated`, whole body                                                                                    | Synchronous                                                                  | in renderer |
| `Prototype.prepareStateWrites` | `PrototypeRuntime.validated`, only the branch that calls `prepareStateWrites(from)` (first write, and after a host replace) | Synchronous, nested in `Prototype.validateStateWrite`                        | in renderer |
| `Prototype.mapRenderTree`      | `PrototypeRenderMapper.map`, the miss path only (after the same-snapshot early return)                                      | Synchronous                                                                  | in renderer |
| `Prototype.mapPrototypeSpec`   | `mapPrototypeSpec` in `PrototypeRenderModel.kt`, whole body (the uncached full mapping used outside a runtime)              | Synchronous                                                                  | in renderer |
| `Prototype.syncAppearance`     | `PrototypeController.interact`, around `syncAppearance(runtime, model)` and `syncTextFieldFocus(model)`                     | Async section (appearance event delivery and host focus updates can suspend) | in renderer |
| `Prototype.compose`            | `PrototypeRuntimeContent`, around the `PrototypeSpecContent` call                                                           | Synchronous, begin/end without `try` (composable calls)                      | in renderer |
| `Prototype.node`               | `RenderPrototypeNodeContent`, first and last statement of the body                                                          | Synchronous, constant name; slices per frame = nodes recomposed              | in renderer |
| `Prototype.host.show`          | `PrototypeHost.showOnMain`, whole body                                                                                      | Synchronous                                                                  | in renderer |

Count `Prototype.node` slices per frame (per `Choreographer#doFrame`) to measure the number of nodes
recomposed, which is the epic's target metric. Those inside `Prototype.compose` come from a new render
model; node-local recompositions can run outside that slice. `Prototype.mapRenderTree` should appear
at most once per `Prototype.interact`.

## Vertical `scroll` first-show cost (#12139)

`scroll` composes and measures every child up front (`Box(verticalScroll)`); the owner
decision is to keep every row findable (no `LazyColumn`), so the question was whether that
costs enough to justify deferring off-screen rows behind same-size placeholders. The gated
`PrototypeScrollMeasurementTest` (`PROTOTYPE_SCROLL_MEASURE=1`, optional
`PROTOTYPE_SCROLL_MEASURE_OUT=<file>`) disposes and recomposes a fullscreen scroll of 36 dp rows
15 times after 5 warm-ups under Robolectric and times setContent through `waitForIdle`
(first composition plus measure and layout; no draw). Two runs, medians:

| Scenario                                     | Render nodes | Semantics nodes | Median ms | p90 ms    |
| -------------------------------------------- | ------------ | --------------- | --------- | --------- |
| trivial column (fixed overhead)              | 2            | 3               | 6.4-7.6   | 7.7-9.6   |
| 87 rows (largest measured prototype)         | 176          | 90              | 4.1-4.9   | 4.4-8.0   |
| benchmark list (`benchmark/prototype-frame`) | 335          | 183             | 7.7-7.9   | 12.5-17.4 |
| 200 rows                                     | 402          | 203             | 4.5-5.0   | 5.7       |
| 500 rows                                     | 1002         | 503             | 17.6-17.9 | 31.9-35.8 |

Scenarios run in JUnit's method-name-hash order (trivial, 500, benchmark list, 87, 200), not
the order above, so the first two carry more JIT/GC warm-up than the last two and the trivial
case reads slower than 87 rows for that reason. The numbers exclude spec-to-render-model mapping
(the runtime's cached render model is reused) and draw. Cost is not linear in rows: 87 to 200
rows adds under 1 ms, 200 to 500 rows adds roughly 13 ms (about 42-45 us per row, inflated by the
500-row case running early), and only 500 rows reaches a median of about 18 ms. Every row text is
present in the semantics tree in every scenario (asserted). Robolectric numbers are not device frame times:
the on-device figure for the benchmark list (`scripts/android/prototype-frame-benchmark.sh
--scenario scroll`) is still owed before any deferral is built.
